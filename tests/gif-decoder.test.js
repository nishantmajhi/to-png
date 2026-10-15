"use strict";

/*
 * The GIF decoder -- the one non-trivial algorithm in the project, and the one
 * piece of it that had never had an assertion made about it.
 *
 * Most of the fixtures here are built byte by byte by `tests/gifbuild.js` from
 * the GIF89a specification, not captured from the decoder. A two-by-two image
 * whose every pixel is known in advance is what pins disposal and interlace;
 * the 33-frame cartoon in `samples/` only proves that something came out.
 *
 * Four of these checks were written against the original code first. Three of
 * them never finished -- the decoder looped forever, allocating, until Node
 * ran out of heap, which is a browser tab that stops responding and cannot be
 * caught by the `try` that wraps the call.
 */

const test = require("node:test");
const assert = require("node:assert");

const { loadScript, canvasStub, sampleArrayBuffer } = require("./helpers.js");
const { buildGif, toArrayBuffer } = require("./gifbuild.js");

/* Colours used by the built fixtures, so an assertion can name them. */
const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];
const PALETTE = [RED, GREEN, BLUE, WHITE];

function decoder() {
  const stub = canvasStub();
  const sandbox = loadScript("vendor/gif-decoder.js", { document: stub.document });
  return { decode: sandbox.window.GifDecoder.decode, stub };
}

/* The decoder runs in a vm context, so the Error it throws is that realm's
 * Error and `instanceof Error` is false here. This is the same cross-realm
 * trap as ArrayBuffer.isView below, and it is worth knowing about before it
 * presents as "the decoder threw something that is not an Error". */
function isError(err) {
  return Object.prototype.toString.call(err) === "[object Error]" && typeof err.message === "string";
}

/* Reads one pixel out of a decoded frame as [r, g, b, a]. */
function pixel(frame, x, y) {
  const i = (y * frame.imageData.width + x) * 4;
  return Array.from(frame.imageData.data.slice(i, i + 4));
}

/* The whole frame as a grid of pixels, which reads better in a diff than a
 * flat array of several thousand numbers. */
function grid(frame) {
  const { width, height } = frame.imageData;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = [];
    for (let x = 0; x < width; x++) row.push(pixel(frame, x, y).join(","));
    rows.push(row);
  }
  return rows;
}

const TRANSPARENT = "0,0,0,0";
const R = "255,0,0,255";
const G = "0,255,0,255";
const B = "0,0,255,255";
const W = "255,255,255,255";

/* ---------------------------------------------------------------- basics -- */

test("a single-frame GIF decodes to its pixels", () => {
  const { decode } = decoder();
  const gif = buildGif({
    width: 2, height: 2, palette: PALETTE,
    frames: [{ width: 2, height: 2, indices: [0, 1, 2, 3] }],
  });
  const result = decode(toArrayBuffer(gif));
  assert.strictEqual(result.width, 2);
  assert.strictEqual(result.height, 2);
  assert.strictEqual(result.frames.length, 1);
  assert.deepStrictEqual(grid(result.frames[0]), [[R, G], [B, W]]);
});

test("something that is not a GIF is refused by name", () => {
  const { decode } = decoder();
  assert.throws(
    () => decode(toArrayBuffer(Buffer.from("this is not a GIF at all, not even close"))),
    /Not a GIF/,
  );
});

test("both GIF signatures are accepted", () => {
  const { decode } = decoder();
  const gif = buildGif({
    width: 1, height: 1, palette: PALETTE, frames: [{ width: 1, height: 1, indices: [1] }],
  });
  assert.strictEqual(decode(toArrayBuffer(gif)).frames.length, 1);

  const gif87 = Buffer.from(gif);
  gif87.write("GIF87a", 0, "ascii");
  assert.strictEqual(decode(toArrayBuffer(gif87)).frames.length, 1);
});

test("an application extension between frames is skipped, not choked on", () => {
  const { decode } = decoder();
  const gif = buildGif({
    width: 1, height: 1, palette: PALETTE, loop: true,
    frames: [{ width: 1, height: 1, indices: [2] }],
  });
  const result = decode(toArrayBuffer(gif));
  assert.strictEqual(result.frames.length, 1);
  assert.deepStrictEqual(pixel(result.frames[0], 0, 0), [0, 0, 255, 255]);
});

test("a local colour table overrides the global one for that frame", () => {
  const { decode } = decoder();
  const gif = buildGif({
    width: 1, height: 1, palette: PALETTE,
    frames: [
      { width: 1, height: 1, indices: [0] },
      { width: 1, height: 1, indices: [0], palette: [GREEN, RED, BLUE, WHITE], disposal: 2 },
    ],
  });
  const result = decode(toArrayBuffer(gif));
  assert.deepStrictEqual(pixel(result.frames[0], 0, 0), [255, 0, 0, 255], "global table: index 0 is red");
  assert.deepStrictEqual(pixel(result.frames[1], 0, 0), [0, 255, 0, 255], "local table: index 0 is green");
});

/* ----------------------------------------------------------- transparency -- */

test("the transparent index leaves a pixel clear rather than colouring it", () => {
  const { decode } = decoder();
  const gif = buildGif({
    width: 2, height: 1, palette: PALETTE,
    frames: [{ width: 2, height: 1, indices: [0, 1], transparentIndex: 1 }],
  });
  const result = decode(toArrayBuffer(gif));
  assert.deepStrictEqual(grid(result.frames[0]), [[R, TRANSPARENT]]);
});

test("a transparent pixel lets the frame underneath show through", () => {
  const { decode } = decoder();
  const gif = buildGif({
    width: 2, height: 1, palette: PALETTE,
    frames: [
      { width: 2, height: 1, indices: [0, 0] },
      { width: 2, height: 1, indices: [1, 2], transparentIndex: 1, disposal: 1 },
    ],
  });
  const result = decode(toArrayBuffer(gif));
  assert.deepStrictEqual(grid(result.frames[1]), [[R, B]], "the left pixel keeps frame 1's red");
});

/* ---------------------------------------------------------------- layout -- */

test("a frame smaller than the screen is placed at its own offset", () => {
  const { decode } = decoder();
  const gif = buildGif({
    width: 3, height: 3, palette: PALETTE,
    frames: [
      { width: 3, height: 3, indices: [0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { width: 1, height: 1, left: 2, top: 1, indices: [1], disposal: 1 },
    ],
  });
  const result = decode(toArrayBuffer(gif));
  assert.deepStrictEqual(grid(result.frames[1]), [[R, R, R], [R, R, G], [R, R, R]]);
});

test("a frame hanging off the edge of the screen is clipped, not wrapped", () => {
  const { decode } = decoder();
  const gif = buildGif({
    width: 2, height: 2, palette: PALETTE,
    frames: [
      { width: 2, height: 2, indices: [0, 0, 0, 0] },
      { width: 2, height: 2, left: 1, top: 1, indices: [1, 1, 1, 1], disposal: 1 },
    ],
  });
  const result = decode(toArrayBuffer(gif));
  assert.deepStrictEqual(grid(result.frames[1]), [[R, R], [R, G]]);
});

test("an interlaced frame comes out in the right row order", () => {
  const { decode } = decoder();
  /* Eight rows, each a single colour, so a mis-ordered pass is unmissable. */
  const rows = [0, 1, 2, 3, 0, 1, 2, 3];
  const indices = [];
  for (const c of rows) indices.push(c, c);
  const gif = buildGif({
    width: 2, height: 8, palette: PALETTE,
    frames: [{ width: 2, height: 8, indices, interlaced: true }],
  });
  const result = decode(toArrayBuffer(gif));
  const expected = rows.map((c) => {
    const colour = [R, G, B, W][c];
    return [colour, colour];
  });
  assert.deepStrictEqual(grid(result.frames[0]), expected);
});

test("the same pixels interlaced and not interlaced decode identically", () => {
  const { decode } = decoder();
  const indices = [];
  for (let i = 0; i < 2 * 9; i++) indices.push(i % 4);
  const plain = decode(toArrayBuffer(buildGif({
    width: 2, height: 9, palette: PALETTE,
    frames: [{ width: 2, height: 9, indices }],
  })));
  const woven = decode(toArrayBuffer(buildGif({
    width: 2, height: 9, palette: PALETTE,
    frames: [{ width: 2, height: 9, indices, interlaced: true }],
  })));
  assert.deepStrictEqual(grid(woven.frames[0]), grid(plain.frames[0]));
});

/* -------------------------------------------------------------- disposal -- */

/*
 * The four disposal methods, each checked by what the NEXT frame looks like,
 * because that is the only place disposal shows. This is the decoder's
 * cleverest code and the part a hand-rolled decoder most often gets wrong.
 */

test("disposal 1 (do not dispose) leaves the previous frame underneath", () => {
  const { decode } = decoder();
  const gif = buildGif({
    width: 2, height: 1, palette: PALETTE,
    frames: [
      { width: 2, height: 1, indices: [0, 0], disposal: 1 },
      { width: 1, height: 1, left: 0, top: 0, indices: [1], disposal: 1 },
      { width: 1, height: 1, left: 1, top: 0, indices: [2], disposal: 1 },
    ],
  });
  const result = decode(toArrayBuffer(gif));
  assert.deepStrictEqual(grid(result.frames[2]), [[G, B]], "both earlier frames should still be there");
});

test("disposal 2 (restore to background) clears only that frame's rectangle", () => {
  const { decode } = decoder();
  const gif = buildGif({
    width: 3, height: 1, palette: PALETTE,
    frames: [
      { width: 3, height: 1, indices: [0, 0, 0], disposal: 1 },
      { width: 1, height: 1, left: 1, top: 0, indices: [1], disposal: 2 },
      { width: 1, height: 1, left: 2, top: 0, indices: [2], disposal: 1 },
    ],
  });
  const result = decode(toArrayBuffer(gif));
  assert.deepStrictEqual(grid(result.frames[1]), [[R, G, R]], "frame 2 draws green in the middle");
  assert.deepStrictEqual(
    grid(result.frames[2]),
    [[R, TRANSPARENT, B]],
    "frame 2's rectangle is cleared to transparent before frame 3 draws, and only that rectangle",
  );
});

test("disposal 3 (restore to previous) puts back exactly what was there before", () => {
  const { decode } = decoder();
  const gif = buildGif({
    width: 3, height: 1, palette: PALETTE,
    frames: [
      { width: 3, height: 1, indices: [0, 1, 2], disposal: 1 },
      { width: 3, height: 1, indices: [3, 3, 3], disposal: 3 },
      { width: 1, height: 1, left: 0, top: 0, indices: [3], disposal: 1 },
    ],
  });
  const result = decode(toArrayBuffer(gif));
  assert.deepStrictEqual(grid(result.frames[0]), [[R, G, B]]);
  assert.deepStrictEqual(grid(result.frames[1]), [[W, W, W]]);
  assert.deepStrictEqual(
    grid(result.frames[2]),
    [[W, G, B]],
    "frame 2 is undone before frame 3 draws, so frame 1's green and blue return",
  );
});

test("disposal 0 (unspecified) is treated the same as 1", () => {
  const { decode } = decoder();
  const build = (disposal) => buildGif({
    width: 2, height: 1, palette: PALETTE,
    frames: [
      { width: 2, height: 1, indices: [0, 0], disposal },
      { width: 1, height: 1, indices: [1], disposal: 1 },
    ],
  });
  const zero = decode(toArrayBuffer(build(0)));
  const one = decode(toArrayBuffer(build(1)));
  assert.deepStrictEqual(grid(zero.frames[1]), grid(one.frames[1]));
});

test("every frame is a whole composited screen, not just its own rectangle", () => {
  const { decode } = decoder();
  const gif = buildGif({
    width: 4, height: 4, palette: PALETTE,
    frames: [
      { width: 4, height: 4, indices: new Array(16).fill(0), disposal: 1 },
      { width: 1, height: 1, left: 3, top: 3, indices: [1], disposal: 1 },
    ],
  });
  const result = decode(toArrayBuffer(gif));
  for (const frame of result.frames) {
    assert.strictEqual(frame.imageData.width, 4);
    assert.strictEqual(frame.imageData.height, 4);
  }
  assert.deepStrictEqual(pixel(result.frames[1], 0, 0), [255, 0, 0, 255], "the rest of the screen is still there");
});

/* ----------------------------------------------------------------- delay -- */

test("a frame delay is carried through in milliseconds", () => {
  const { decode } = decoder();
  const gif = buildGif({
    width: 1, height: 1, palette: PALETTE,
    frames: [
      { width: 1, height: 1, indices: [0], delayRaw: 7, disposal: 1 },
      { width: 1, height: 1, indices: [1], delayRaw: 25, disposal: 1 },
    ],
  });
  const result = decode(toArrayBuffer(gif));
  assert.strictEqual(result.frames[0].delayMs, 70);
  assert.strictEqual(result.frames[1].delayMs, 250);
});

/*
 * REGRESSION. Delays of 0 and 1 hundredths are the convention for "as fast as
 * you can", and every browser renders them at 100ms. The original passed 0
 * through its `|| 100` and so landed on 100 by accident, but passed 1 through
 * as 10ms -- and the player's own `Math.max(20, ...)` then made it 20ms.
 * A GIF written with delay 1, which is extremely common, played five times too
 * fast, in a tool whose README says playback "matches the original timing".
 */
test("delays of 0 and 1 hundredths become 100ms, the way every browser renders them", () => {
  const { decode } = decoder();
  const gif = buildGif({
    width: 1, height: 1, palette: PALETTE,
    frames: [
      { width: 1, height: 1, indices: [0], delayRaw: 0, disposal: 1 },
      { width: 1, height: 1, indices: [1], delayRaw: 1, disposal: 1 },
      { width: 1, height: 1, indices: [2], delayRaw: 2, disposal: 1 },
    ],
  });
  const result = decode(toArrayBuffer(gif));
  assert.strictEqual(result.frames[0].delayMs, 100, "delay 0 is the browsers' 100ms");
  assert.strictEqual(result.frames[1].delayMs, 100, "delay 1 is too, and this is the one that was wrong");
  assert.strictEqual(result.frames[2].delayMs, 20, "delay 2 is a real 20ms and stays one");
});

test("a graphic control extension applies to the next frame only", () => {
  const { decode } = decoder();
  const gif = buildGif({
    width: 1, height: 1, palette: PALETTE,
    frames: [
      { width: 1, height: 1, indices: [0], delayRaw: 50, transparentIndex: 3, disposal: 1 },
      { width: 1, height: 1, indices: [1], disposal: 1 },
    ],
  });
  const result = decode(toArrayBuffer(gif));
  assert.strictEqual(result.frames[0].delayMs, 500);
  assert.strictEqual(result.frames[1].delayMs, 100, "the second frame has no GCE and gets the default");
  assert.deepStrictEqual(pixel(result.frames[1], 0, 0), [0, 255, 0, 255], "and no leftover transparent index");
});

/* ------------------------------------------------------------- damage ---- */

/*
 * REGRESSION, and the worst defect in this file.
 *
 * `readSubBlocks` walked the sub-block chain with `pos += len + 1` and stopped
 * only on a zero-length block. Past the end of the buffer `len` is `undefined`,
 * `undefined + 1` is NaN, `pos` becomes NaN and stays NaN, `data[NaN]` is
 * undefined forever -- and the loop pushes an empty array on every iteration.
 *
 * So a GIF missing its last few bytes did not fail. It allocated until the
 * process died. Under Node that is an out-of-memory abort in about a second;
 * in a browser it is the tab freezing, and the `try { GifDecoder.decode() }`
 * in `gif.js` cannot catch it, because nothing is thrown. A partial download
 * or a file copied off a full disk is enough to trigger it.
 *
 * Each of these must return or throw promptly. If any of them hangs, the
 * runner's own timeout is what reports it.
 */
test("a truncated GIF fails promptly instead of allocating forever", { timeout: 20000 }, () => {
  const { decode } = decoder();
  const whole = buildGif({
    width: 4, height: 4, palette: PALETTE,
    frames: [
      { width: 4, height: 4, indices: new Array(16).fill(0), delayRaw: 10, disposal: 1 },
      { width: 4, height: 4, indices: new Array(16).fill(1), delayRaw: 10, disposal: 1 },
    ],
  });

  for (let cut = 1; cut < whole.length; cut++) {
    const piece = whole.subarray(0, cut);
    let outcome;
    try {
      const result = decode(toArrayBuffer(piece));
      outcome = "returned " + result.frames.length + " frame(s)";
    } catch (err) {
      outcome = "threw";
      assert.ok(isError(err), "cut at " + cut + " should throw an Error, threw " + err);
      assert.ok(err.message.length > 0, "cut at " + cut + " should say something");
    }
    assert.ok(outcome, "cut at " + cut);
  }
});

test("a real GIF truncated part way through still fails promptly", { timeout: 30000 }, () => {
  const { decode } = decoder();
  const whole = Buffer.from(new Uint8Array(sampleArrayBuffer("blue-and-bingo.gif")));
  for (const fraction of [0.1, 0.5, 0.9, 0.99, 0.999, 1 - 1 / whole.length]) {
    const piece = whole.subarray(0, Math.floor(whole.length * fraction));
    try {
      decode(toArrayBuffer(piece));
    } catch (err) {
      assert.ok(isError(err), "at " + fraction + " it should throw an Error, threw " + err);
    }
  }
});

test("what did decode out of a truncated GIF is kept", () => {
  const { decode } = decoder();
  const whole = buildGif({
    width: 2, height: 2, palette: PALETTE,
    frames: [
      { width: 2, height: 2, indices: [0, 1, 2, 3], disposal: 1 },
      { width: 2, height: 2, indices: [3, 2, 1, 0], disposal: 1 },
    ],
  });
  /* Everything but the trailer: both frames are complete. */
  const result = decode(toArrayBuffer(whole.subarray(0, whole.length - 1)));
  assert.strictEqual(result.frames.length, 2, "a missing trailer should not lose a complete frame");
  assert.deepStrictEqual(grid(result.frames[0]), [[R, G], [B, W]]);
});

test("a GIF with a header and nothing else is refused rather than returning nothing", () => {
  const { decode } = decoder();
  const whole = buildGif({
    width: 2, height: 2, palette: PALETTE,
    frames: [{ width: 2, height: 2, indices: [0, 1, 2, 3] }],
  });
  /* Header plus global colour table, no image descriptor. `gif.js` reads
   * `result.frames[0].imageData` when there is one frame, so an empty list
   * would surface as "cannot read properties of undefined". */
  assert.throws(() => decode(toArrayBuffer(whole.subarray(0, 19))), /GIF|frame|truncat/i);
});

test("a garbage block type stops the walk without hanging", { timeout: 10000 }, () => {
  const { decode } = decoder();
  const whole = buildGif({
    width: 2, height: 2, palette: PALETTE,
    frames: [{ width: 2, height: 2, indices: [0, 1, 2, 3], disposal: 1 }],
  });
  const corrupt = Buffer.from(whole);
  corrupt[corrupt.length - 1] = 0x99; /* the trailer, replaced by nonsense */
  const result = decode(toArrayBuffer(corrupt));
  assert.strictEqual(result.frames.length, 1);
});

test("an image descriptor with no colour table anywhere is refused", () => {
  const { decode } = decoder();
  const gif = buildGif({
    width: 1, height: 1, palette: PALETTE,
    frames: [{ width: 1, height: 1, indices: [0] }],
  });
  const noGlobal = Buffer.from(gif);
  noGlobal[10] &= 0x7f; /* clear the global-colour-table flag */
  assert.throws(() => decode(toArrayBuffer(noGlobal)), /colour|color|table|GIF/i);
});

/* --------------------------------------------------------------- the real -- */

test("the sample GIF decodes to 33 composited frames", () => {
  const { decode } = decoder();
  const result = decode(sampleArrayBuffer("blue-and-bingo.gif"));
  assert.strictEqual(result.width, 480);
  assert.strictEqual(result.height, 480);
  assert.strictEqual(result.frames.length, 33);
  for (const [i, frame] of result.frames.entries()) {
    assert.strictEqual(frame.imageData.width, 480, "frame " + i + " width");
    assert.strictEqual(frame.imageData.height, 480, "frame " + i + " height");
    assert.strictEqual(frame.delayMs, 40, "frame " + i + " delay");
  }
});

test("the sample GIF's frames are not all the same picture", () => {
  const { decode } = decoder();
  const frames = decode(sampleArrayBuffer("blue-and-bingo.gif")).frames;
  const fingerprints = new Set(
    frames.map((f) => {
      let sum = 0;
      for (let i = 0; i < f.imageData.data.length; i += 997) sum = (sum * 31 + f.imageData.data[i]) >>> 0;
      return sum;
    }),
  );
  assert.ok(fingerprints.size > 20, "expected mostly distinct frames, got " + fingerprints.size);
});

test("every pixel of the sample GIF is fully opaque or fully clear", () => {
  const { decode } = decoder();
  const frames = decode(sampleArrayBuffer("blue-and-bingo.gif")).frames;
  for (const [i, frame] of frames.entries()) {
    for (let p = 3; p < frame.imageData.data.length; p += 4) {
      const alpha = frame.imageData.data[p];
      if (alpha !== 0 && alpha !== 255) {
        assert.fail("frame " + i + " has a partially transparent pixel (" + alpha + "); a GIF cannot produce one");
      }
    }
  }
});

test("decoding is deterministic", () => {
  const { decode } = decoder();
  const a = decode(sampleArrayBuffer("blue-and-bingo.gif"));
  const b = decode(sampleArrayBuffer("blue-and-bingo.gif"));
  for (let i = 0; i < a.frames.length; i++) {
    assert.deepStrictEqual(a.frames[i].imageData.data, b.frames[i].imageData.data, "frame " + i);
  }
});

/* ------------------------------------------------------------------- LZW -- */

/*
 * The code width has to climb 9, 10, 11, 12 in step with the writer, and the
 * dictionary has to stop growing at 4096 entries. Every fixture above re-emits
 * a CLEAR often enough that neither ever happens, so this is the only check
 * that reaches either.
 *
 * The dictionary ceiling is a memory fix rather than a correctness one, and it
 * is worth being exact about why, because it would be easy to write it up as
 * worse than it is: the original never capped the dictionary, but a code is at
 * most twelve bits, so entries past 4095 can never be addressed and the extra
 * entries cannot change a pixel. They can only be held. What this check does
 * cover is the width rule, where an off-by-one would garble the frame.
 */
test("the code width grows with the dictionary, up to its ceiling", () => {
  const { decode } = decoder();
  /* 120x120 of pseudo-random indices, encoded with no CLEAR after the first,
   * so the dictionary passes 512, 1024, 2048 and 4096 in one frame. */
  const side = 120;
  const indices = [];
  let seed = 1;
  for (let i = 0; i < side * side; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    indices.push(seed % 4);
  }
  const gif = buildGif({
    width: side, height: side, palette: PALETTE,
    frames: [{ width: side, height: side, indices, growingCodes: true }],
  });
  const result = decode(toArrayBuffer(gif));
  const frame = result.frames[0];
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const expected = PALETTE[indices[y * side + x]];
      assert.deepStrictEqual(
        pixel(frame, x, y), [...expected, 255],
        "pixel " + x + "," + y + " should be index " + indices[y * side + x],
      );
    }
  }
});

/* ------------------------------------------------------------ no DOM at all */

/*
 * The decoder used to build a scratch <canvas> for every frame and let the
 * browser composite, which is why it could not be tested outside one. It
 * composites into a plain array now. `canvasStub` is still handed to it, and
 * this is the assertion that it is never reached -- so the stub cannot quietly
 * become part of what is under test.
 */
test("the decoder creates no DOM elements", () => {
  const { decode, stub } = decoder();
  decode(sampleArrayBuffer("blue-and-bingo.gif"));
  assert.deepStrictEqual(stub.calls, [], "the decoder should not have asked for " + stub.calls.join(", "));
});

test("the decoder runs with no document in scope at all", () => {
  const sandbox = loadScript("vendor/gif-decoder.js");
  assert.strictEqual(sandbox.document, undefined, "no document was provided");
  const result = sandbox.window.GifDecoder.decode(sampleArrayBuffer("blue-and-bingo.gif"));
  assert.strictEqual(result.frames.length, 33);
});

test("the frames are real ImageData, which is what putImageData needs", () => {
  const { decode } = decoder();
  const frame = decode(sampleArrayBuffer("blue-and-bingo.gif")).frames[0];
  assert.ok(frame.imageData instanceof require("./helpers.js").ImageData);
  /* ArrayBuffer.isView rather than instanceof: the decoder allocates inside a
   * vm context whose Uint8ClampedArray is a different function object. */
  assert.ok(ArrayBuffer.isView(frame.imageData.data));
  assert.strictEqual(frame.imageData.data.constructor.name, "Uint8ClampedArray");
  assert.strictEqual(frame.imageData.data.length, 480 * 480 * 4);
});
