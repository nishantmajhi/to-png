"use strict";

/*
 * Shared plumbing for the Node suite.
 *
 * Two things live here. `startServer` runs the real `server.js` as a real
 * child process and talks to it over a real socket -- the server's whole job
 * is HTTP, so a test that called its functions directly would be testing
 * something else. And `loadScript` evaluates one of the browser files in a
 * `node:vm` context, which is how the client-side logic is reached at all:
 * every one of those files is a plain <script>, with no module system to
 * import from.
 */

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SAMPLES = path.join(ROOT, "samples");

/*
 * Asks the OS for a free port, closes it, and hands the number to the server.
 * The obvious alternative -- PORT=0, then read the port back out of what the
 * server prints -- is not available, because this suite has to be runnable
 * against the original code as well, and the original prints the value of
 * $PORT rather than the port it actually bound.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(env = {}) {
  const port = env.PORT ? Number(env.PORT) : await freePort();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (why) => {
      if (settled) return;
      settled = true;
      reject(new Error(why + "\nstdout: " + stdout + "\nstderr: " + stderr));
    };
    const timer = setTimeout(() => fail("server printed no URL within 10s"), 10000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdout.on("data", (d) => {
      stdout += d;
      if (settled || !/http:\/\//.test(stdout)) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        port,
        child,
        get announced() { return stdout.trim(); },
        get stderr() { return stderr; },
        alive: () => child.exitCode === null && child.signalCode === null,
        stop: () => new Promise((done) => {
          if (child.exitCode !== null || child.signalCode !== null) return done();
          child.once("exit", () => done());
          child.kill();
        }),
      });
    });
    child.once("exit", (code) => { clearTimeout(timer); fail("server exited early with code " + code); });
  });
}

/*
 * A request that resolves rather than throwing, so a test can assert on a
 * dropped connection as readily as on a status code -- which matters here,
 * because the defect this suite was written for is the server dying mid
 * request. The body comes back as a Buffer, since not everything served is
 * text.
 */
function request(server, reqPath, { method = "GET", headers = {}, host } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: host || "127.0.0.1", port: server.port, path: reqPath, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body, text: body.toString("utf8") });
        });
      },
    );
    req.on("error", (err) => resolve({ error: err.code || String(err) }));
    req.end();
  });
}

/*
 * `ImageData` is the only browser type the GIF decoder needs, and it is a
 * plain holder of three fields -- so this is a transcription rather than a
 * model, and there is nothing in it that could drift from what a browser does.
 * Everything with real behaviour (compositing, disposal, interlace) is the
 * decoder's own code, run unmodified. `tests/browser/` runs the same fixture
 * through the same file in a real Chrome and compares every frame byte for
 * byte, so the claim in this paragraph is checked rather than asserted.
 */
class ImageData {
  constructor(a, b, c) {
    /* `ArrayBuffer.isView`, not `instanceof Uint8ClampedArray`. The decoder
     * runs inside a `node:vm` context, which has its own intrinsics, so the
     * array it allocates is not an instance of *this* realm's
     * Uint8ClampedArray and the instanceof is false. That sent construction
     * down the width/height branch and produced an ImageData of NaN by NaN --
     * a failure that reads like a decoder bug and is not one. */
    if (ArrayBuffer.isView(a)) {
      this.data = a;
      this.width = b;
      this.height = c === undefined ? a.length / 4 / b : c;
    } else {
      this.width = a;
      this.height = b;
      this.data = new Uint8ClampedArray(a * b * 4);
    }
    if (this.data.length !== this.width * this.height * 4) {
      throw new Error("ImageData: data length does not match the dimensions");
    }
  }
}

/*
 * A canvas, enough of one to run the ORIGINAL GIF decoder.
 *
 * It exists for one reason: the suite has to be runnable against the code as
 * it was, and the original decoder composited frames by creating a scratch
 * <canvas> per frame and letting the browser do the alpha blending. That made
 * it untestable outside a browser, which is why it had no tests.
 *
 * The current decoder composites into a plain array and touches no DOM at all,
 * and `tests/gif-decoder.test.js` asserts that -- this object records every
 * call made to it, and the assertion is that the count is zero. So this is a
 * scaffold for the before-and-after comparison rather than part of the model
 * under test, and it cannot quietly become load-bearing without a test failing.
 */
function canvasStub() {
  const calls = [];
  function context(canvas) {
    const at = (x, y) => (y * canvas.width + x) * 4;
    return {
      createImageData: (w, h) => new ImageData(w, h),
      getImageData(x, y, w, h) {
        const out = new ImageData(w, h);
        for (let row = 0; row < h; row++) {
          for (let col = 0; col < w; col++) {
            const s = at(x + col, y + row);
            const d = (row * w + col) * 4;
            for (let k = 0; k < 4; k++) out.data[d + k] = canvas.px[s + k];
          }
        }
        return out;
      },
      putImageData(img, x, y) {
        for (let row = 0; row < img.height; row++) {
          for (let col = 0; col < img.width; col++) {
            const d = at(x + col, y + row);
            const s = (row * img.width + col) * 4;
            for (let k = 0; k < 4; k++) canvas.px[d + k] = img.data[s + k];
          }
        }
      },
      clearRect(x, y, w, h) {
        for (let row = 0; row < h; row++) {
          for (let col = 0; col < w; col++) {
            const ty = y + row;
            const tx = x + col;
            if (ty < 0 || tx < 0 || ty >= canvas.height || tx >= canvas.width) continue;
            const d = at(tx, ty);
            canvas.px[d] = canvas.px[d + 1] = canvas.px[d + 2] = canvas.px[d + 3] = 0;
          }
        }
      },
      /* Source-over, for a source whose alpha is only ever 0 or 255 -- which
       * is all a GIF can produce, so no blending arithmetic is needed. */
      drawImage(src, x, y) {
        for (let row = 0; row < src.height; row++) {
          for (let col = 0; col < src.width; col++) {
            const ty = y + row;
            const tx = x + col;
            if (ty < 0 || tx < 0 || ty >= canvas.height || tx >= canvas.width) continue;
            const s = (row * src.width + col) * 4;
            if (src.px[s + 3] === 0) continue;
            const d = at(tx, ty);
            for (let k = 0; k < 4; k++) canvas.px[d + k] = src.px[s + k];
          }
        }
      },
    };
  }

  const document = {
    createElement(tag) {
      calls.push(tag);
      if (tag !== "canvas") throw new Error("the stub only makes canvases, was asked for " + tag);
      const canvas = {
        _w: 0, _h: 0, px: new Uint8ClampedArray(0),
        get width() { return this._w; },
        set width(v) { this._w = v; this.px = new Uint8ClampedArray(this._w * this._h * 4); },
        get height() { return this._h; },
        set height(v) { this._h = v; this.px = new Uint8ClampedArray(this._w * this._h * 4); },
      };
      const ctx = context(canvas);
      canvas.getContext = () => ctx;
      return canvas;
    },
  };
  return { document, calls };
}

/*
 * Evaluates one or more of `public/`'s scripts in a fresh context, in the
 * order given, and hands back the shared global object -- which is how the
 * browser runs them too, since they are plain <script> tags sharing one scope.
 * The files are read from disk on every call, so no test can run against a
 * stale copy of something another test edited.
 */
function loadScript(relativePaths, extraGlobals = {}) {
  const files = Array.isArray(relativePaths) ? relativePaths : [relativePaths];
  const sandbox = { console, ImageData, setTimeout, clearTimeout, ...extraGlobals };
  sandbox.window = sandbox.window || sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of files) {
    const file = path.join(ROOT, "public", rel);
    vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: rel });
  }
  return sandbox;
}

function sampleBuffer(name) {
  return fs.readFileSync(path.join(SAMPLES, name));
}

/*
 * An ArrayBuffer rather than a Buffer. The real callers get theirs from
 * `FileReader` or `File.arrayBuffer()`, and a Buffer's byteOffset into a
 * shared pool is exactly the kind of difference that lets a decoder pass a
 * test and fail in a page.
 */
function sampleArrayBuffer(name) {
  const b = sampleBuffer(name);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

module.exports = {
  ROOT, SAMPLES, freePort, startServer, request,
  loadScript, canvasStub, sampleBuffer, sampleArrayBuffer, ImageData,
};
