"use strict";

/*
 * The real pages, served by the real server, in a real browser.
 *
 * The Node suite reaches everything that can be reached without one: the
 * server over a socket, the GIF decoder, and the pure decisions in logic.js.
 * What it cannot reach is the part where the worst defect in this project
 * lived -- a canvas whose bitmap is cleared by assigning to its width, and a
 * download that snapshotted it one line too early. No model of a canvas can
 * settle that. A browser can.
 *
 * Four things are checked here and nowhere else:
 *
 *   - what the Download button actually hands to the browser, decoded back
 *     into pixels;
 *   - that loading a second file detaches the first file's player, instead of
 *     leaving both listening on the same four buttons;
 *   - that the rewritten GIF decoder produces in Chrome exactly the frames the
 *     Node suite asserts against its own ImageData transcription;
 *   - that the pages load and run at all, from the real server, with the new
 *     logic.js script tag in place.
 *
 * Chrome is driven with `--headless=new` and nothing else: no driver, no
 * protocol client, no dependency. The project is copied to a scratch directory
 * with one script tag appended to each page, and each copy is checked against
 * the real file byte for byte up to that line, so a page that had drifted from
 * the one under test fails loudly. Each page posts its results back to a small
 * collector the runner listens on; see the note above `drive` for why that is
 * rather than `--dump-dom`.
 *
 * `--original` stages the baseline commit instead, to answer the question the
 * suite is otherwise assuming the answer to. It should fail exactly the checks
 * named in EXPECTED_BASELINE_FAILURES, and exits 0 when it does.
 *
 * With no browser installed this exits 0 and says SKIP.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const ORIGINAL = process.argv.includes("--original");
const BASELINE_SUBJECT = "Initial commit";

const CANDIDATES = [
  process.env.TOPNG_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

function findBrowser() {
  for (const candidate of CANDIDATES) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not there */
    }
  }
  return null;
}

const PAGES = ["svg", "webp", "gif", "avif"];
const APPENDED = '\n<script src="/driver.js"></script>\n';

function baselineSha() {
  const sha = execFileSync(
    "git", ["log", "--format=%H", "--grep=^" + BASELINE_SUBJECT + "$", "--max-count=1"],
    { cwd: ROOT, encoding: "utf8" },
  ).trim().split("\n")[0];
  if (!sha) throw new Error("no baseline commit found");
  return sha;
}

function fromBaseline(sha, relative) {
  return execFileSync("git", ["show", sha + ":" + relative], {
    cwd: ROOT, maxBuffer: 32 * 1024 * 1024,
  });
}

/*
 * Copies the project into a scratch directory. The current tree is copied from
 * disk; the baseline is read out of git, file by file, so `--original` needs
 * no checkout and cannot disturb the working tree.
 */
function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "to-png-browser-"));
  fs.mkdirSync(path.join(dir, "public", "vendor"), { recursive: true });
  fs.mkdirSync(path.join(dir, "public", "fixtures"), { recursive: true });

  const sha = ORIGINAL ? baselineSha() : null;
  const read = (relative) =>
    ORIGINAL ? fromBaseline(sha, relative) : fs.readFileSync(path.join(ROOT, relative));

  /* The baseline has no logic.js; asking git for it would throw. */
  const publicFiles = ORIGINAL
    ? execFileSync("git", ["ls-tree", "--name-only", "-r", sha, "public/"], { cwd: ROOT, encoding: "utf8" })
        .trim().split("\n").filter(Boolean)
    : listFiles(path.join(ROOT, "public")).map((f) => "public/" + f.split(path.sep).join("/"));

  for (const relative of publicFiles) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, read(relative));
  }
  fs.writeFileSync(path.join(dir, "server.js"), read("server.js"));

  /* The samples, reachable over HTTP so a page can fetch one and hand it to
   * its own dropzone the way a person hands it a file. In the baseline commit
   * they are still under test/ rather than samples/. */
  const sampleDir = ORIGINAL ? "test" : "samples";
  const sampleNames = ORIGINAL
    ? execFileSync("git", ["ls-tree", "--name-only", "-r", sha, sampleDir + "/"], { cwd: ROOT, encoding: "utf8" })
        .trim().split("\n").filter(Boolean).map((f) => path.posix.basename(f))
    : fs.readdirSync(path.join(ROOT, sampleDir));
  for (const name of sampleNames) {
    fs.writeFileSync(path.join(dir, "public", "fixtures", name), read(sampleDir + "/" + name));
  }

  fs.copyFileSync(path.join(__dirname, "driver.js"), path.join(dir, "public", "driver.js"));

  for (const page of PAGES) {
    const file = path.join(dir, "public", page + ".html");
    const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, original + APPENDED, "utf8");

    /* The page under test must be the page it claims to be. */
    const staged = fs.readFileSync(file, "utf8");
    if (staged.slice(0, original.length) !== original || staged.slice(original.length) !== APPENDED) {
      throw new Error(page + ".html: the staged copy is not the page plus exactly one script tag");
    }
  }
  return dir;
}

function listFiles(root, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, rel));
    else out.push(rel);
  }
  return out;
}

function freePort() {
  const net = require("node:net");
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startServer(dir, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error("staged server did not start: " + out)), 10000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { out += d; });
    child.stdout.on("data", (d) => {
      out += d;
      if (!/http:\/\//.test(out)) return;
      clearTimeout(timer);
      resolve(child);
    });
  });
}

/*
 * The page posts its results back to a collector on a second port, and the
 * runner waits for that post. The obvious alternative -- `--dump-dom` with
 * `--virtual-time-budget` -- was tried first and does not work here. Virtual
 * time fast-forwards timers but not the work they are waiting for, so a
 * `toBlob` encode or an <img> load that takes real milliseconds is skipped
 * past, and the page dumps before it has finished. Everything in this suite is
 * waiting on exactly that kind of work, so it runs in real time instead.
 */
function collector() {
  const http = require("node:http");
  const pending = new Map();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      res.end();
      const page = new URL(req.url, "http://localhost").searchParams.get("page");
      const waiter = pending.get(page);
      if (waiter) {
        pending.delete(page);
        try {
          waiter.resolve(JSON.parse(body));
        } catch (err) {
          waiter.reject(new Error(page + " posted something that is not JSON: " + body.slice(0, 300)));
        }
      }
    });
  });
  return {
    server,
    listen: (port) => new Promise((r) => server.listen(port, "127.0.0.1", r)),
    await: (page, ms) => new Promise((resolve, reject) => {
      pending.set(page, { resolve, reject });
      setTimeout(() => {
        if (pending.has(page)) {
          pending.delete(page);
          reject(new Error(page + " posted no results within " + ms + "ms"));
        }
      }, ms).unref();
    }),
  };
}

async function drive(browser, dir, url, page, sink) {
  const child = spawn(browser, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--disable-extensions",
    "--disable-features=Translate,MediaRouter",
    "--user-data-dir=" + path.join(dir, "profile-" + page),
    url,
  ], { stdio: "ignore" });
  try {
    return await sink.await(page, 180000);
  } finally {
    child.kill();
  }
}

/*
 * What the baseline is expected to fail. Naming them rather than counting them
 * means a run against the original that starts passing something, or that
 * fails for a new reason, is visible instead of being absorbed into a total.
 *
 * The truncated-GIF defect is deliberately not exercised here. Against the
 * original it does not fail, it hangs the renderer, and a hung renderer
 * produces no DOM at all -- so one check would take every other check on the
 * page with it. `tests/gif-decoder.test.js` covers it, with every prefix of a
 * file rather than one.
 */
const EXPECTED_BASELINE_FAILURES = [
  /* logic.js did not exist yet, so every page fails its own smoke check. */
  "svg: the page loaded its scripts",
  "svg: the Download button snapshots the drawing, not a blank canvas",
  "svg: the downloaded PNG is the size the controls ask for",
  "svg: changing the scale changes what is downloaded",
  "svg: an SVG sized in percentages uses its viewBox",
  "svg: a failed encode is reported rather than passing silently",
  "gif: loading a second file detaches the first file's player",
  "gif: a capture-all in progress does not spill into the next file",
  "gif: pausing after a second load does not restart the first animation",
  "gif: the decoder runs in a browser with no canvas",
];

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.log("SKIP: no Chrome or Edge found. Set TOPNG_BROWSER to one to run these.");
    return 0;
  }

  const dir = stage();
  const port = await freePort();
  const sinkPort = await freePort();
  const server = await startServer(dir, port);
  const sink = collector();
  await sink.listen(sinkPort);

  let results = [];
  try {
    for (const page of PAGES) {
      const url = "http://127.0.0.1:" + port + "/" + page +
        "?collector=" + sinkPort + (ORIGINAL ? "&baseline=1" : "");
      const pageResults = await drive(browser, dir, url, page, sink);
      results = results.concat(pageResults.map((r) => ({ ...r, name: page + ": " + r.name })));
    }
  } finally {
    server.kill();
    sink.server.close();
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log((r.ok ? "  ok   " : "  FAIL ") + r.name + (r.ok && r.detail ? "  (" + r.detail + ")" : ""));
    if (!r.ok) console.log("         " + String(r.error).split("\n")[0]);
  }
  console.log("");
  console.log(results.length + " checks, " + (results.length - failed.length) + " passed, " + failed.length + " failed" +
    (ORIGINAL ? "  [against the original]" : ""));

  if (!ORIGINAL) {
    if (failed.length) return 1;
    console.log("Browser: all green.");
    return 0;
  }

  const failedNames = failed.map((r) => r.name).sort();
  const expected = EXPECTED_BASELINE_FAILURES.slice().sort();
  const unexpected = failedNames.filter((n) => !expected.includes(n));
  const missing = expected.filter((n) => !failedNames.includes(n));

  console.log("");
  if (unexpected.length) console.log("Failed against the original for reasons not predicted:\n  " + unexpected.join("\n  "));
  if (missing.length) console.log("Expected to fail against the original but did not:\n  " + missing.join("\n  "));
  if (!unexpected.length && !missing.length) {
    console.log("The original fails exactly the " + expected.length + " checks it was predicted to fail.");
    return 0;
  }
  return 1;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
