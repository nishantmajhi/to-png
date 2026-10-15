"use strict";

/*
 * The rewritten decoder against the original, frame by frame and byte by byte.
 *
 * The decoder was changed substantially: it used to composite by creating a
 * scratch <canvas> per frame and letting the browser blend, and it now
 * composites into a plain array. That was worth doing -- it is why the decoder
 * can be tested at all, and the frozen-tab defect lived in the same file --
 * but "I rewrote the cleverest code in the project" is exactly the claim that
 * deserves a check rather than a paragraph.
 *
 * So: fetch the original out of git, run both over the same fixtures, and
 * require every pixel of every frame to agree. The fixtures cover all four
 * disposal methods, interlace, transparency, per-frame colour tables and an
 * application extension, plus the real 33-frame sample.
 *
 * The original cannot be given damaged input here. That is the one place the
 * two deliberately differ, and it is not a difference that can be measured by
 * comparison, because the original does not return: it allocates until the
 * process dies. `tests/gif-decoder.test.js` covers the new behaviour on its
 * own.
 */

const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { ROOT, canvasStub, sampleArrayBuffer, ImageData } = require("./helpers.js");
const { buildGif, toArrayBuffer } = require("./gifbuild.js");

const BASELINE_SUBJECT = "Initial commit";
const DECODER = "public/vendor/gif-decoder.js";

function baselineSource() {
  const sha = execFileSync(
    "git",
    ["log", "--format=%H", "--grep=^" + BASELINE_SUBJECT + "$", "--max-count=1", "--", DECODER],
    { cwd: ROOT, encoding: "utf8" },
  ).trim().split("\n")[0];
  if (!sha) throw new Error("no baseline commit found for " + DECODER);
  return execFileSync("git", ["show", sha + ":" + DECODER], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  });
}

function evaluate(source) {
  const stub = canvasStub();
  const sandbox = { console, ImageData, setTimeout, clearTimeout, document: stub.document };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "gif-decoder.js" });
  return sandbox.window.GifDecoder.decode;
}

let original = null;
let current = null;
let skip = false;

test.before(() => {
  try {
    original = evaluate(baselineSource());
  } catch (err) {
    /* No git, a shallow clone, or a renamed first commit: say so and skip,
     * rather than reporting a comparison that was never made. */
    console.log("      (cannot reach the original decoder in git: " + err.message + ")");
    skip = true;
    return;
  }
  current = evaluate(fs.readFileSync(path.join(ROOT, DECODER), "utf8"));
});

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];
const PALETTE = [RED, GREEN, BLUE, WHITE];

function agree(t, label, arrayBuffer) {
  if (skip) return t.skip("the original decoder is not reachable");
  const a = original(arrayBuffer);
  const b = current(arrayBuffer);

  assert.strictEqual(b.width, a.width, label + ": screen width");
  assert.strictEqual(b.height, a.height, label + ": screen height");
  assert.strictEqual(b.frames.length, a.frames.length, label + ": frame count");

  for (let i = 0; i < a.frames.length; i++) {
    assert.strictEqual(
      b.frames[i].imageData.width, a.frames[i].imageData.width, label + ": frame " + i + " width",
    );
    const from = a.frames[i].imageData.data;
    const to = b.frames[i].imageData.data;
    assert.strictEqual(to.length, from.length, label + ": frame " + i + " byte count");
    for (let k = 0; k < from.length; k++) {
      if (from[k] !== to[k]) {
        const pixel = Math.floor(k / 4);
        assert.fail(
          label + ": frame " + i + ", pixel " + (pixel % a.width) + "," + Math.floor(pixel / a.width) +
          ", channel " + (k % 4) + ": was " + from[k] + ", now " + to[k],
        );
      }
    }
  }
}

test("the real sample decodes to exactly the same pixels", (t) => {
  agree(t, "blue-and-bingo.gif", sampleArrayBuffer("blue-and-bingo.gif"));
});

test("all four disposal methods composite to exactly the same pixels", (t) => {
  agree(t, "disposal", toArrayBuffer(buildGif({
    width: 4, height: 4, palette: PALETTE,
    frames: [
      { width: 4, height: 4, indices: new Array(16).fill(0), disposal: 1, delayRaw: 5 },
      { width: 2, height: 2, left: 1, top: 1, indices: [1, 1, 1, 1], disposal: 2, delayRaw: 5 },
      { width: 4, height: 4, indices: new Array(16).fill(2), disposal: 3, delayRaw: 5 },
      { width: 1, height: 1, left: 3, top: 3, indices: [3], disposal: 0, delayRaw: 5 },
      { width: 4, height: 4, indices: new Array(16).fill(1), disposal: 1, delayRaw: 5 },
    ],
  })));
});

test("interlace and transparency together decode to exactly the same pixels", (t) => {
  agree(t, "interlaced", toArrayBuffer(buildGif({
    width: 2, height: 8, palette: PALETTE,
    frames: [{
      width: 2, height: 8,
      indices: Array.from({ length: 16 }, (_, i) => i % 4),
      interlaced: true, transparentIndex: 2, delayRaw: 5,
    }],
  })));
});

test("per-frame colour tables and extensions decode to exactly the same pixels", (t) => {
  agree(t, "local tables", toArrayBuffer(buildGif({
    width: 3, height: 3, palette: PALETTE, loop: true,
    frames: [
      { width: 3, height: 3, indices: Array.from({ length: 9 }, (_, i) => i % 4), delayRaw: 9 },
      {
        width: 3, height: 3,
        indices: Array.from({ length: 9 }, (_, i) => (i + 1) % 4),
        palette: [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]],
        disposal: 2, delayRaw: 9,
      },
    ],
  })));
});

test("a frame hanging off the edge is clipped exactly the same way", (t) => {
  agree(t, "clipped", toArrayBuffer(buildGif({
    width: 3, height: 3, palette: PALETTE,
    frames: [
      { width: 3, height: 3, indices: new Array(9).fill(0), disposal: 1, delayRaw: 5 },
      { width: 3, height: 3, left: 2, top: 2, indices: new Array(9).fill(1), disposal: 2, delayRaw: 5 },
      { width: 3, height: 3, indices: new Array(9).fill(3), disposal: 1, delayRaw: 5 },
    ],
  })));
});

/*
 * The one deliberate difference, asserted rather than left implicit. Every
 * browser renders a stored delay of 0 or 1 hundredths at 100ms; the original
 * turned 1 into 10ms, which the player then floored at 20ms, so a GIF written
 * with delay 1 -- a very common thing -- played five times too fast in a tool
 * whose README says the preview matches the file's real timing.
 */
test("frame delays agree except where the original was too fast", (t) => {
  if (skip) return t.skip("the original decoder is not reachable");
  const gif = toArrayBuffer(buildGif({
    width: 1, height: 1, palette: PALETTE,
    frames: [0, 1, 2, 7, 100].map((delayRaw) => ({
      width: 1, height: 1, indices: [0], delayRaw, disposal: 1,
    })),
  }));
  /* Array.from, because the decoders run in vm contexts and the arrays they
   * return have that realm's Array.prototype -- which deepStrictEqual checks,
   * so two visibly identical lists of numbers compare unequal without it. */
  const before = Array.from(original(gif).frames, (f) => f.delayMs);
  const after = Array.from(current(gif).frames, (f) => f.delayMs);
  assert.deepStrictEqual(before, [100, 10, 20, 70, 1000], "what the original produced");
  assert.deepStrictEqual(after, [100, 100, 20, 70, 1000], "and what it produces now");
});
