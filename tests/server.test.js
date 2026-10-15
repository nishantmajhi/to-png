"use strict";

/*
 * The server, driven over a real socket.
 *
 * Its whole job is HTTP -- routing, path resolution, content types, caching --
 * so every check here goes through a real request to a real child process.
 * Four of them were written against the original code first and all four
 * failed: one request took the whole server down, one escaped the directory
 * the server is supposed to be confined to, the site was offered to the whole
 * local network, and the announced URL could name a port nothing was
 * listening on.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { ROOT, startServer, request } = require("./helpers.js");

/* One server for the whole file. The checks are independent of each other and
 * a process per check would treble the runtime for nothing -- except in the
 * handful below that deliberately need a server of their own. */
let server;
test.before(async () => { server = await startServer(); });
test.after(async () => { if (server) await server.stop(); });

function externalIPv4() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

test("every route serves its own page", async () => {
  const expected = {
    "/": "svg.html",
    "/svg": "svg.html",
    "/webp": "webp.html",
    "/gif": "gif.html",
    "/avif": "avif.html",
  };
  for (const [route, file] of Object.entries(expected)) {
    const res = await request(server, route);
    assert.strictEqual(res.status, 200, route + " should be 200");
    assert.strictEqual(
      res.text,
      fs.readFileSync(path.join(ROOT, "public", file), "utf8"),
      route + " should serve " + file,
    );
    assert.match(res.headers["content-type"], /^text\/html/, route + " content type");
  }
});

test("static assets are served with the right content type", async () => {
  const expected = [
    ["/style.css", /^text\/css/],
    ["/shared.js", /^text\/javascript/],
    ["/svg.js", /^text\/javascript/],
    ["/vendor/gif-decoder.js", /^text\/javascript/],
  ];
  for (const [reqPath, pattern] of expected) {
    const res = await request(server, reqPath);
    assert.strictEqual(res.status, 200, reqPath);
    assert.match(res.headers["content-type"], pattern, reqPath);
  }
});

test("a missing file is 404, not a crash", async () => {
  const res = await request(server, "/nothing-here.js");
  assert.strictEqual(res.status, 404);
  assert.ok(server.alive(), "the server should still be running");
});

test("a directory is not served as a file", async () => {
  const res = await request(server, "/vendor");
  assert.strictEqual(res.status, 404);
});

test("anything but GET or HEAD is refused", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await request(server, "/", { method });
    assert.strictEqual(res.status, 405, method);
  }
});

test("HEAD gives the headers and no body", async () => {
  const res = await request(server, "/style.css", { method: "HEAD" });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers["content-type"], /^text\/css/);
  assert.strictEqual(res.body.length, 0, "HEAD must not carry a body");
  assert.ok(res.headers["content-length"], "HEAD should still declare the length");
});

/*
 * REGRESSION. One request for `/%` killed the server outright.
 *
 * `decodeURIComponent` throws URIError on a malformed escape and it was called
 * unguarded inside the request handler, so the throw left the handler as an
 * uncaught exception and Node ended the process. Not a 500 -- the whole server
 * gone, every open tab with it, and nothing to be done but restart it from a
 * terminal. A mistyped link with a stray percent sign in it is enough.
 */
test("a malformed percent-escape is a 400 and the server survives", async () => {
  const own = await startServer();
  try {
    for (const bad of ["/%", "/%zz", "/%e0%a4", "/a%", "/%%", "/vendor/%c0"]) {
      const res = await request(own, bad);
      assert.strictEqual(res.error, undefined, bad + " should answer, not drop the connection");
      assert.strictEqual(res.status, 400, bad + " should be 400");
      assert.ok(own.alive(), "the server should still be running after " + bad);
    }
    const after = await request(own, "/");
    assert.strictEqual(after.status, 200, "and should still serve pages afterwards");
  } finally {
    await own.stop();
  }
});

/*
 * REGRESSION, and the same crash reached by a second route. `%00` decodes
 * perfectly well, so the guard above does not catch it -- but `fs.stat`
 * rejects a NUL byte in a path by throwing synchronously, and that throw is
 * inside the request handler too.
 */
test("a NUL byte in the path is refused and the server survives", async () => {
  const own = await startServer();
  try {
    for (const bad of ["/%00", "/style%00.css", "/vendor/%00"]) {
      const res = await request(own, bad);
      assert.strictEqual(res.error, undefined, bad + " should answer, not drop the connection");
      assert.strictEqual(res.status, 400, bad + " should be 400");
    }
    assert.strictEqual((await request(own, "/")).status, 200, "and should still serve pages");
  } finally {
    await own.stop();
  }
});

/*
 * REGRESSION. The traversal guard was `resolved.startsWith(base)`, which is a
 * string test wearing the clothes of a path test. Any sibling directory whose
 * name merely begins with "public" satisfied it, so
 * `/../public-secret/leak.txt` came back 200 with the file in it.
 *
 * The first review singled this check out for praise -- "right order, right
 * check". The order is right. The check is not.
 */
test("a sibling directory whose name starts with the served one is refused", async () => {
  const sibling = path.join(ROOT, "public-regression-fixture");
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, "leak.txt"), "must not be served", "utf8");
  try {
    for (const attempt of [
      "/../public-regression-fixture/leak.txt",
      "/..%2fpublic-regression-fixture%2fleak.txt",
    ]) {
      const res = await request(server, attempt);
      assert.notStrictEqual(res.status, 200, attempt + " must not be served");
      assert.ok(!res.text.includes("must not be served"), attempt + " leaked the file");
    }
  } finally {
    fs.rmSync(sibling, { recursive: true, force: true });
  }
});

test("ordinary path traversal is refused", async () => {
  for (const attempt of [
    "/../server.js",
    "/../README.md",
    "/../../../../../../etc/passwd",
    "/..%2F..%2Fserver.js",
    "/%2e%2e/server.js",
    "/....//server.js",
  ]) {
    const res = await request(server, attempt);
    assert.notStrictEqual(res.status, 200, attempt + " must not be served");
  }
  assert.ok(server.alive());
});

test("the served directory itself is still reachable", async () => {
  const res = await request(server, "/./style.css");
  assert.strictEqual(res.status, 200, "a harmless . segment should not be mistaken for an escape");
});

/*
 * REGRESSION. The announced URL was built from $PORT rather than from the port
 * the server actually bound, so `PORT=0 node server.js` -- the ordinary way of
 * asking the OS for any free port -- printed `http://localhost:0`, which is
 * not an address anything is listening on.
 */
test("the announced URL names the port that was actually bound", async () => {
  const own = await startServer({ PORT: "0" });
  try {
    const m = own.announced.match(/http:\/\/[^:]+:(\d+)/);
    assert.ok(m, "the server should print a URL, got: " + own.announced);
    const announced = Number(m[1]);
    assert.notStrictEqual(announced, 0, "printing port 0 tells the reader nothing");
    const res = await request({ port: announced }, "/");
    assert.strictEqual(res.status, 200, "the announced port should serve the site");
  } finally {
    await own.stop();
  }
});

/*
 * REGRESSION. `server.listen(PORT)` with no host binds every interface, so a
 * tool whose own subtitle is "runs entirely in your browser, nothing is
 * uploaded" was also serving itself to everyone on the network. HOST is
 * honoured so that sharing it on purpose stays possible.
 */
test("by default the server is not reachable from off the machine", async () => {
  const own = await startServer();
  try {
    assert.strictEqual((await request(own, "/")).status, 200, "127.0.0.1 should work");
    const addresses = externalIPv4();
    for (const address of addresses) {
      const res = await request(own, "/", { host: address });
      assert.ok(
        res.error === "ECONNREFUSED" || res.error === "ETIMEDOUT" || res.error === "EHOSTUNREACH",
        "binding should refuse " + address + ", got " + JSON.stringify(res),
      );
    }
    if (addresses.length === 0) {
      console.log("      (this machine has no external IPv4 interface to check against)");
    }
  } finally {
    await own.stop();
  }
});

test("HOST is honoured when sharing is what you want", async () => {
  const addresses = externalIPv4();
  if (addresses.length === 0) return;
  const own = await startServer({ HOST: "0.0.0.0" });
  try {
    const res = await request(own, "/", { host: addresses[0] });
    assert.strictEqual(res.status, 200, "HOST=0.0.0.0 should be reachable at " + addresses[0]);
  } finally {
    await own.stop();
  }
});

/*
 * REGRESSION, a smaller one. A 304 was sent with no ETag and no Cache-Control,
 * and the ETag on the 200 was unquoted, which is not a valid entity-tag. Both
 * are things a browser forgives and a proxy does not.
 */
test("conditional requests revalidate", async () => {
  const first = await request(server, "/style.css");
  assert.strictEqual(first.status, 200);
  const etag = first.headers.etag;
  assert.ok(etag, "a 200 should carry an ETag");
  assert.match(etag, /^"[^"]+"$/, "an entity-tag is quoted, this one is " + etag);

  const second = await request(server, "/style.css", { headers: { "if-none-match": etag } });
  assert.strictEqual(second.status, 304, "an unchanged file should revalidate");
  assert.strictEqual(second.body.length, 0, "a 304 carries no body");
  assert.strictEqual(second.headers.etag, etag, "a 304 must repeat the ETag");

  const stale = await request(server, "/style.css", { headers: { "if-none-match": '"not-the-etag"' } });
  assert.strictEqual(stale.status, 200, "a stale tag should get the file");
});

test("a weak validator still matches", async () => {
  const first = await request(server, "/shared.js");
  const res = await request(server, "/shared.js", {
    headers: { "if-none-match": "W/" + first.headers.etag },
  });
  assert.strictEqual(res.status, 304, "W/ prefixed tags compare equal under a weak comparison");
});

test("a list of validators matches if any of them does", async () => {
  const first = await request(server, "/shared.js");
  const res = await request(server, "/shared.js", {
    headers: { "if-none-match": '"something-else", ' + first.headers.etag },
  });
  assert.strictEqual(res.status, 304);
});

test("if-none-match: * always matches an existing file", async () => {
  const res = await request(server, "/shared.js", { headers: { "if-none-match": "*" } });
  assert.strictEqual(res.status, 304);
});

test("editing a file changes its ETag", async () => {
  const marker = path.join(ROOT, "public", "regression-etag.js");
  fs.writeFileSync(marker, "// one\n", "utf8");
  try {
    const before = (await request(server, "/regression-etag.js")).headers.etag;
    fs.writeFileSync(marker, "// two\n", "utf8");
    const after = await request(server, "/regression-etag.js", { headers: { "if-none-match": before } });
    assert.strictEqual(after.status, 200, "an edited file must not revalidate as unchanged");
    assert.notStrictEqual(after.headers.etag, before);
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test("error responses say what they are", async () => {
  for (const [reqPath, status] of [["/nope", 404], ["/%", 400]]) {
    const res = await request(server, reqPath);
    assert.strictEqual(res.status, status, reqPath);
    assert.match(
      res.headers["content-type"] || "",
      /^text\/plain/,
      reqPath + " should declare its body as text rather than leave it to be sniffed",
    );
  }
});

test("a query string is not part of the filename", async () => {
  const withQuery = await request(server, "/style.css?v=2");
  const without = await request(server, "/style.css");
  assert.strictEqual(withQuery.status, 200);
  assert.deepStrictEqual(withQuery.body, without.body);
});

test("a route still routes when it carries a query string", async () => {
  const res = await request(server, "/gif?from=somewhere");
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /GIF frame/);
});

test("a percent-encoded path resolves to the same file", async () => {
  const res = await request(server, "/%73tyle.css");
  const plain = await request(server, "/style.css");
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, plain.body);
});

test("an unknown extension is served as a byte stream rather than guessed at", async () => {
  const marker = path.join(ROOT, "public", "regression-fixture.bin");
  fs.writeFileSync(marker, Buffer.from([0, 1, 2, 3]));
  try {
    const res = await request(server, "/regression-fixture.bin");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers["content-type"], "application/octet-stream");
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test("two servers can run at once on different ports", async () => {
  const a = await startServer();
  const b = await startServer();
  try {
    assert.notStrictEqual(a.port, b.port);
    assert.strictEqual((await request(a, "/")).status, 200);
    assert.strictEqual((await request(b, "/")).status, 200);
  } finally {
    await a.stop();
    await b.stop();
  }
});

/*
 * REGRESSION. Starting a second copy printed a twenty-line Node stack trace
 * with EADDRINUSE buried in it. For a tool people are told to start by typing
 * `node server.js`, "port 3000 is already in use" is the entire content of
 * that trace.
 */
test("a port already in use fails with a message rather than a stack trace", async () => {
  const taken = await startServer();
  try {
    const clash = spawnSync(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(taken.port) },
      encoding: "utf8",
      timeout: 15000,
    });
    assert.notStrictEqual(clash.status, 0, "it should not claim success");
    const said = (clash.stderr || "") + (clash.stdout || "");
    assert.match(said, /already in use/i, "it should say the port is taken, said: " + said.slice(0, 400));
    assert.ok(!/\n\s+at /.test(said), "and not by printing a stack trace: " + said.slice(0, 400));
  } finally {
    await taken.stop();
  }
});
