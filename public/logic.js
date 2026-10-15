// logic.js -- the decisions the four converter pages make, with no DOM in
// them, so they can be run and asserted on outside a browser.
//
// Everything here was previously inline in svg.js, webp.js and avif.js, where
// it was tangled with element lookups and canvas calls and therefore untested.
// Two of the three defects these functions now pin were found by writing the
// assertion rather than by reading the code.

(function (global) {
  'use strict';

  // A generous heuristic for "does this SVG animate itself": SMIL animation
  // elements, or an inline <style> using CSS animations / transitions. It
  // can't catch animation driven entirely by external JS (there's nothing to
  // detect -- that isn't a property of the file), but that covers every
  // self-contained animated SVG.
  function svgLooksAnimated(svgText) {
    return (
      /<animate(transform|motion)?\b/i.test(svgText) ||
      /<set\b/i.test(svgText) ||
      /@keyframes/i.test(svgText) ||
      /\banimation(-name)?\s*:/i.test(svgText)
    );
  }

  // A length attribute in CSS pixels, or null if it is not one.
  //
  // `parseFloat` is not this function, and using it was a bug: `width="100%"`
  // gave 100, so an SVG sized in percentages -- which is how most SVGs written
  // for the web are sized -- exported as a 100 by 100 image with its artwork
  // squeezed into the corner, instead of at the size its viewBox asks for.
  // `2em` gave 2. Anything carrying a unit other than px is not a pixel count
  // and the viewBox is the better answer.
  function pixelLength(value) {
    if (typeof value !== 'string') return null;
    const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px)?\s*$/.exec(value);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // The width and height an SVG asks to be drawn at, from its own attributes,
  // falling back to the viewBox and then to the SVG default of 300 by 150.
  function svgIntrinsicSize(widthAttr, heightAttr, viewBoxAttr) {
    let w = pixelLength(widthAttr);
    let h = pixelLength(heightAttr);

    if ((!w || !h) && typeof viewBoxAttr === 'string') {
      const parts = viewBoxAttr.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)) {
        if (!w && parts[2] > 0) w = parts[2];
        if (!h && parts[3] > 0) h = parts[3];
      }
    }
    return { w: w || 300, h: h || 150 };
  }

  // The pixel size to render at, given the form controls and the intrinsic
  // size. Clamped so that a scale of 8 on a large drawing cannot ask for a
  // canvas no browser will allocate -- past which `toBlob` returns null and
  // the download silently does nothing.
  const MAX_OUTPUT_SIDE = 16384;

  function svgOutputSize(opts) {
    const scale = parseFloat(opts.scale) || 1;
    const w = parseInt(opts.width, 10) || opts.baseWidth;
    const h = parseInt(opts.height, 10) || opts.baseHeight;
    const clamp = (n) => Math.min(MAX_OUTPUT_SIDE, Math.max(1, Math.round(n)));
    return { w: clamp(w * scale), h: clamp(h * scale) };
  }

  // Looks for a four-character chunk or box name in the first `limit` bytes of
  // a file. Used to tell "this is an animation this browser cannot split" from
  // "this is a single still image", so the page can say which. WebP marks an
  // animation with an ANIM chunk; an AVIF image *sequence* carries a moov box,
  // which a single still ("mif1") does not.
  function containsFourCC(arrayBuffer, fourCC, limit) {
    const length = Math.min(arrayBuffer.byteLength, limit || 8192);
    const bytes = new Uint8Array(arrayBuffer, 0, length);
    const target = [fourCC.charCodeAt(0), fourCC.charCodeAt(1), fourCC.charCodeAt(2), fourCC.charCodeAt(3)];
    for (let i = 0; i + 3 < bytes.length; i++) {
      if (bytes[i] === target[0] && bytes[i + 1] === target[1] &&
          bytes[i + 2] === target[2] && bytes[i + 3] === target[3]) {
        return true;
      }
    }
    return false;
  }

  // VideoFrame.duration is in microseconds and is null for a frame whose
  // duration the container did not state. 100ms is the same default a browser
  // uses for an unspecified frame duration.
  function frameDurationToMs(microseconds) {
    if (typeof microseconds !== 'number' || !Number.isFinite(microseconds) || microseconds <= 0) return 100;
    return Math.max(1, microseconds / 1000);
  }

  const api = {
    svgLooksAnimated,
    pixelLength,
    svgIntrinsicSize,
    svgOutputSize,
    containsFourCC,
    frameDurationToMs,
    MAX_OUTPUT_SIDE,
  };

  global.ToPngLogic = api;
  // Named exports as well, because svg.js referred to svgLooksAnimated as a
  // bare global and the pages share one scope.
  global.svgLooksAnimated = svgLooksAnimated;
})(typeof window !== 'undefined' ? window : globalThis);
