"use strict";

/*
 * The decisions the four converter pages make, tested away from the DOM.
 *
 * Two of the things pinned here were defects. `parseFloat` was being used to
 * read an SVG's width attribute, which turns "100%" into 100; and a WebP or
 * AVIF whose frames could not be split said nothing at all unless the reason
 * was a missing ImageDecoder API.
 */

const test = require("node:test");
const assert = require("node:assert");

const { loadScript, sampleArrayBuffer } = require("./helpers.js");

const L = loadScript("logic.js").ToPngLogic;

/* logic.js is evaluated in a vm context, so the plain objects it returns carry
 * that realm's Object.prototype -- and deepStrictEqual compares prototypes, so
 * { w: 750, h: 500 } from over there is not deep-equal to { w: 750, h: 500 }
 * from here. Spreading copies the fields into this realm. It is the same trap
 * as the ones in gif-decoder.test.js, in its third disguise. */
const intrinsic = (...args) => ({ ...L.svgIntrinsicSize(...args) });
const output = (opts) => ({ ...L.svgOutputSize(opts) });

/* ------------------------------------------------- is this SVG animated -- */

test("SMIL animation elements are detected", () => {
  for (const markup of [
    '<svg><animate attributeName="x" /></svg>',
    '<svg><animateTransform type="rotate" /></svg>',
    '<svg><animateMotion path="M0,0" /></svg>',
    '<svg><set attributeName="fill" to="red" /></svg>',
    '<svg><ANIMATE /></svg>',
  ]) {
    assert.strictEqual(L.svgLooksAnimated(markup), true, markup);
  }
});

test("CSS animation in an inline style is detected", () => {
  for (const markup of [
    "<svg><style>@keyframes spin { from {} to {} }</style></svg>",
    "<svg><style>.a { animation: spin 2s linear infinite }</style></svg>",
    "<svg><style>.a { animation-name: spin }</style></svg>",
  ]) {
    assert.strictEqual(L.svgLooksAnimated(markup), true, markup);
  }
});

test("a still SVG is not called animated", () => {
  for (const markup of [
    '<svg><rect width="10" height="10" /></svg>',
    '<svg><text>no animation here</text></svg>',
    '<svg><g id="animated-looking-id" /></svg>',
    '<svg><rect class="animation" /></svg>',
  ]) {
    assert.strictEqual(L.svgLooksAnimated(markup), false, markup);
  }
});

test("the project's own two samples are classified correctly", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { SAMPLES } = require("./helpers.js");
  const animated = fs.readFileSync(path.join(SAMPLES, "animated-green-astronaut-helmet.svg"), "utf8");
  const still = fs.readFileSync(path.join(SAMPLES, "svg-sample-transparent-large.svg"), "utf8");
  assert.strictEqual(L.svgLooksAnimated(animated), true, "the astronaut helmet animates");
  assert.strictEqual(L.svgLooksAnimated(still), false, "the large transparent sample does not");
});

/* ---------------------------------------------------------- pixelLength -- */

test("a plain number, with or without px, is a pixel length", () => {
  assert.strictEqual(L.pixelLength("300"), 300);
  assert.strictEqual(L.pixelLength("300px"), 300);
  assert.strictEqual(L.pixelLength(" 300 px "), 300);
  assert.strictEqual(L.pixelLength("12.5"), 12.5);
  assert.strictEqual(L.pixelLength(".5"), 0.5);
  assert.strictEqual(L.pixelLength("1e3"), 1000);
});

/*
 * REGRESSION. This was `parseFloat`, which stops at the first character it
 * cannot use -- so "100%" came back as 100.
 */
test("a length carrying any other unit is not a pixel length", () => {
  for (const value of ["100%", "2em", "10rem", "1in", "12pt", "3cm", "auto", "", "  ", "abc", "-5", "0"]) {
    assert.strictEqual(L.pixelLength(value), null, JSON.stringify(value) + " is not a pixel count");
  }
  assert.strictEqual(L.pixelLength(null), null);
  assert.strictEqual(L.pixelLength(undefined), null);
});

/* ------------------------------------------------------ svgIntrinsicSize -- */

test("explicit pixel width and height win", () => {
  assert.deepStrictEqual(intrinsic("800", "600", "0 0 100 50"), { w: 800, h: 600 });
  assert.deepStrictEqual(intrinsic("800px", "600px", null), { w: 800, h: 600 });
});

test("the viewBox supplies whatever the attributes do not", () => {
  assert.deepStrictEqual(intrinsic(null, null, "0 0 750 500"), { w: 750, h: 500 });
  assert.deepStrictEqual(intrinsic("400", null, "0 0 750 500"), { w: 400, h: 500 });
  assert.deepStrictEqual(intrinsic(null, "250", "0 0 750 500"), { w: 750, h: 250 });
});

test("a viewBox may be separated by commas or extra spaces", () => {
  assert.deepStrictEqual(intrinsic(null, null, "0,0,640,480"), { w: 640, h: 480 });
  assert.deepStrictEqual(intrinsic(null, null, "  0 0   640  480 "), { w: 640, h: 480 });
  assert.deepStrictEqual(intrinsic(null, null, "0, 0, 640, 480"), { w: 640, h: 480 });
});

/*
 * REGRESSION, and the reason pixelLength exists. An SVG written for the web is
 * very often sized `width="100%" height="100%"` with the real dimensions in
 * the viewBox. The old code read those as 100 and 100 and never consulted the
 * viewBox, so a 1200 by 800 drawing exported as a 100 by 100 image -- with the
 * artwork scaled down into it, not cropped, so it looked like a deliberate
 * thumbnail rather than a bug.
 */
test("a percentage width falls back to the viewBox", () => {
  assert.deepStrictEqual(intrinsic("100%", "100%", "0 0 1200 800"), { w: 1200, h: 800 });
  assert.deepStrictEqual(intrinsic("50%", "100%", "0 0 1200 800"), { w: 1200, h: 800 });
  assert.deepStrictEqual(intrinsic("10em", "5em", "0 0 640 480"), { w: 640, h: 480 });
});

test("with nothing to go on it is the SVG default of 300 by 150", () => {
  assert.deepStrictEqual(intrinsic(null, null, null), { w: 300, h: 150 });
  assert.deepStrictEqual(intrinsic("100%", "100%", null), { w: 300, h: 150 });
  assert.deepStrictEqual(intrinsic(null, null, "not a viewbox"), { w: 300, h: 150 });
  assert.deepStrictEqual(intrinsic(null, null, "0 0 100"), { w: 300, h: 150 });
  assert.deepStrictEqual(intrinsic(null, null, "0 0 0 0"), { w: 300, h: 150 });
});

/* -------------------------------------------------------- svgOutputSize -- */

test("the scale multiplies the requested size", () => {
  const base = { baseWidth: 750, baseHeight: 500 };
  assert.deepStrictEqual(output({ scale: "1", width: "750", height: "500", ...base }), { w: 750, h: 500 });
  assert.deepStrictEqual(output({ scale: "2", width: "750", height: "500", ...base }), { w: 1500, h: 1000 });
  assert.deepStrictEqual(output({ scale: "8", width: "100", height: "50", ...base }), { w: 800, h: 400 });
});

test("an empty or nonsense box falls back to the intrinsic size", () => {
  const base = { baseWidth: 750, baseHeight: 500 };
  assert.deepStrictEqual(output({ scale: "1", width: "", height: "", ...base }), { w: 750, h: 500 });
  assert.deepStrictEqual(output({ scale: "", width: "abc", height: "abc", ...base }), { w: 750, h: 500 });
  assert.deepStrictEqual(output({ scale: "2", width: "0", height: "0", ...base }), { w: 1500, h: 1000 });
});

test("the output is never smaller than one pixel", () => {
  const r = output({ scale: "1", width: "-40", height: "-40", baseWidth: -10, baseHeight: -10 });
  assert.ok(r.w >= 1 && r.h >= 1, JSON.stringify(r));
});

/*
 * 8x on a large drawing asks for a canvas no browser will allocate, and the
 * failure mode is silent: the canvas stays at 0 by 0, toBlob hands back null,
 * and the download simply does not happen. Clamping produces a large image
 * instead of nothing. `triggerPngDownload` now reports the null case too, so
 * neither half of this is silent any more.
 */
test("an impossible canvas size is clamped rather than left to fail silently", () => {
  const r = output({ scale: "8", width: "9000", height: "9000", baseWidth: 9000, baseHeight: 9000 });
  assert.strictEqual(r.w, L.MAX_OUTPUT_SIDE);
  assert.strictEqual(r.h, L.MAX_OUTPUT_SIDE);
});

/* ------------------------------------------------------- containsFourCC -- */

test("the animated WebP sample is recognised as animated", () => {
  assert.strictEqual(L.containsFourCC(sampleArrayBuffer("animated-webp-3.webp"), "ANIM", 4096), true);
});

test("the still WebP sample is not", () => {
  assert.strictEqual(L.containsFourCC(sampleArrayBuffer("abstract-whale-webp.webp"), "ANIM", 4096), false);
});

test("the AVIF image sequence is recognised and the still one is not", () => {
  assert.strictEqual(L.containsFourCC(sampleArrayBuffer("animated-avif-12-frames-hq-lossy.avif"), "moov", 8192), true);
  assert.strictEqual(L.containsFourCC(sampleArrayBuffer("avif-sample.avif"), "moov", 8192), false);
});

test("the scan stops at the limit it was given", () => {
  const buf = new Uint8Array(200);
  buf.set([0x41, 0x4e, 0x49, 0x4d], 150); /* "ANIM" at byte 150 */
  const ab = buf.buffer;
  assert.strictEqual(L.containsFourCC(ab, "ANIM", 200), true);
  assert.strictEqual(L.containsFourCC(ab, "ANIM", 100), false, "past the limit it should not be found");
});

test("a match right at the start or right at the end is found", () => {
  const atStart = new Uint8Array([0x41, 0x4e, 0x49, 0x4d, 0, 0]);
  const atEnd = new Uint8Array([0, 0, 0x41, 0x4e, 0x49, 0x4d]);
  assert.strictEqual(L.containsFourCC(atStart.buffer, "ANIM", 4096), true);
  assert.strictEqual(L.containsFourCC(atEnd.buffer, "ANIM", 4096), true);
});

test("a buffer shorter than the tag is not a match and does not throw", () => {
  assert.strictEqual(L.containsFourCC(new Uint8Array([0x41, 0x4e]).buffer, "ANIM", 4096), false);
  assert.strictEqual(L.containsFourCC(new Uint8Array(0).buffer, "ANIM", 4096), false);
});

test("the tags are matched case-sensitively, as the formats define them", () => {
  const lower = new Uint8Array([0x61, 0x6e, 0x69, 0x6d]); /* "anim" */
  assert.strictEqual(L.containsFourCC(lower.buffer, "ANIM", 4096), false);
});

/* --------------------------------------------------- frameDurationToMs -- */

test("a frame duration in microseconds becomes milliseconds", () => {
  assert.strictEqual(L.frameDurationToMs(40000), 40);
  assert.strictEqual(L.frameDurationToMs(100000), 100);
  assert.strictEqual(L.frameDurationToMs(16666), 16.666);
});

test("an absent or nonsensical duration becomes the browsers' default", () => {
  for (const value of [null, undefined, 0, -1, NaN, Infinity, "40000"]) {
    assert.strictEqual(L.frameDurationToMs(value), 100, String(value));
  }
});
