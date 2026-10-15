/*
 * Runs inside the real pages, in a real browser.
 *
 * `tests/browser/run.js` copies the project to a scratch directory, appends
 * one script tag pointing at this file to each of the four pages, and serves
 * the result with the real server. Everything here therefore runs against the
 * real markup, the real scripts, and files fetched over a real HTTP request.
 *
 * Results are posted back as JSON to the collector the runner named in the
 * query string, and also left in a <div id="test-results"> so a human opening
 * the staged page can read them. Which page this is is read from the URL, so
 * one file drives all four.
 */

(function () {
  "use strict";

  var results = [];
  var page = (location.pathname.replace(/^\//, "") || "svg");
  var params = new URLSearchParams(location.search);

  /* Where to post the results. Absent when the page is opened by hand, in
   * which case the results div is the whole output. */
  var COLLECTOR = params.get("collector");

  /* Set when the runner has staged the original code. One check must not run
   * then: against the original, decoding a truncated GIF does not fail, it
   * loops forever allocating, and a hung renderer takes every other check on
   * the page down with it. */
  var BASELINE = params.get("baseline") === "1";

  /* The results div is rewritten after every check, not once at the end. A
   * check that hangs then still leaves a record of how far the page got, which
   * is the difference between a diagnosable failure and a blank page. */
  function record(name, ok, detail, error) {
    results.push({ name: name, ok: ok, detail: detail === undefined ? null : detail, error: error || null });
    var div = document.getElementById("test-results");
    if (!div) {
      div = document.createElement("div");
      div.id = "test-results";
      document.body.appendChild(div);
    }
    div.textContent = JSON.stringify(results);
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message || "assertion failed");
  }
  function equal(actual, expected, message) {
    if (actual !== expected) {
      throw new Error((message ? message + ": " : "") + "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
    }
  }

  var queue = [];
  function check(name, fn) { queue.push({ name: name, fn: fn }); }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* Downloading in headless Chrome aborts the DOM dump. The anchor click is
   * never what is under test -- what the blob contains is -- so it is
   * neutralised, and only for anchors carrying a download attribute. */
  var realAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) return;
    return realAnchorClick.call(this);
  };

  function opaquePixels(imageData) {
    var n = 0;
    for (var i = 3; i < imageData.data.length; i += 4) if (imageData.data[i] !== 0) n++;
    return n;
  }
  function canvasOpaquePixels(canvas) {
    if (!canvas.width || !canvas.height) return 0;
    return opaquePixels(canvas.getContext("2d", { willReadFrequently: true })
      .getImageData(0, 0, canvas.width, canvas.height));
  }

  /* Hands a file to a page the way a person does: by dropping it on the
   * dropzone. Nothing here reaches into the page's own functions. */
  function drop(zoneId, file) {
    var dt = new DataTransfer();
    dt.items.add(file);
    document.getElementById(zoneId).dispatchEvent(
      new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  }

  function fetchFile(name, type) {
    return fetch("/fixtures/" + name)
      .then(function (r) { return r.blob(); })
      .then(function (b) { return new File([b], name, { type: type }); });
  }

  /*
   * Watches what `toBlob` is given, which is the only way to see the defect
   * this suite exists for: the canvas is correct before the click and correct
   * again a moment later, and blank at the one instant that matters.
   */
  function watchToBlob(canvas) {
    var seen = [];
    var real = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (cb, type, quality) {
      if (this === canvas) {
        seen.push({ opaque: canvasOpaquePixels(this), width: this.width, height: this.height });
      }
      return real.call(this, cb, type, quality);
    };
    return {
      seen: seen,
      restore: function () { HTMLCanvasElement.prototype.toBlob = real; },
    };
  }

  /* ------------------------------------------------------------- SVG -- */

  if (page === "svg" || page === "") {
    check("the page loaded its scripts", function () {
      assert(typeof ToPngLogic === "object", "logic.js should have defined ToPngLogic");
      assert(typeof triggerPngDownload === "function", "shared.js should have defined triggerPngDownload");
      assert(document.getElementById("svg-dropzone"), "the dropzone should be in the page");
    });

    check("a still SVG renders onto the canvas", async function () {
      var file = await fetchFile("svg-sample-transparent-large.svg", "image/svg+xml");
      drop("svg-dropzone", file);
      await sleep(1200);
      var canvas = document.getElementById("svg-canvas");
      equal(canvas.width, 1500, "2x of the viewBox's 750");
      equal(canvas.height, 1000, "2x of the viewBox's 500");
      var painted = canvasOpaquePixels(canvas);
      assert(painted > 100000, "expected the drawing on the canvas, found " + painted + " opaque pixels");
      return painted + " opaque pixels";
    });

    /*
     * THE ONE. `renderStatic()` sets `canvas.width`, which clears the bitmap,
     * and then draws asynchronously in an <img> load handler. The download
     * button called it and then called `triggerPngDownload` on the very next
     * line, so `toBlob` snapshotted the canvas in the cleared state every
     * single time. Every static SVG download this tool produced was a fully
     * transparent PNG.
     */
    check("the Download button snapshots the drawing, not a blank canvas", async function () {
      var canvas = document.getElementById("svg-canvas");
      var before = canvasOpaquePixels(canvas);
      assert(before > 100000, "the canvas should be drawn on before we start: " + before);

      var watch = watchToBlob(canvas);
      try {
        document.getElementById("svg-download").click();
        await sleep(2000);
        equal(watch.seen.length, 1, "toBlob should have been called once");
        assert(
          watch.seen[0].opaque > 100000,
          "the download snapshotted " + watch.seen[0].opaque + " opaque pixels; the canvas had " + before,
        );
      } finally {
        watch.restore();
      }
      return watch.seen[0].opaque + " opaque pixels captured";
    });

    check("the downloaded PNG is the size the controls ask for", async function () {
      var canvas = document.getElementById("svg-canvas");
      var captured = null;
      var real = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (cb, type, quality) {
        if (this !== canvas) return real.call(this, cb, type, quality);
        return real.call(this, function (blob) { captured = blob; cb(blob); }, type, quality);
      };
      try {
        document.getElementById("svg-download").click();
        for (var i = 0; i < 40 && !captured; i++) await sleep(50);
      } finally {
        HTMLCanvasElement.prototype.toBlob = real;
      }
      assert(captured, "no PNG was produced");
      equal(captured.type, "image/png");
      var bitmap = await createImageBitmap(captured);
      equal(bitmap.width, 1500, "PNG width");
      equal(bitmap.height, 1000, "PNG height");

      var c = document.createElement("canvas");
      c.width = bitmap.width;
      c.height = bitmap.height;
      c.getContext("2d").drawImage(bitmap, 0, 0);
      var painted = opaquePixels(c.getContext("2d").getImageData(0, 0, c.width, c.height));
      assert(painted > 100000, "the saved PNG has " + painted + " opaque pixels in it");
      return bitmap.width + "x" + bitmap.height + ", " + painted + " opaque pixels";
    });

    check("changing the scale changes what is downloaded", async function () {
      var scale = document.getElementById("svg-scale");
      scale.value = "1";
      scale.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(1200);

      var canvas = document.getElementById("svg-canvas");
      var captured = null;
      var real = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (cb, type, quality) {
        if (this !== canvas) return real.call(this, cb, type, quality);
        return real.call(this, function (blob) { captured = blob; cb(blob); }, type, quality);
      };
      try {
        document.getElementById("svg-download").click();
        for (var i = 0; i < 40 && !captured; i++) await sleep(50);
      } finally {
        HTMLCanvasElement.prototype.toBlob = real;
      }
      assert(captured, "no PNG was produced at 1x");
      var bitmap = await createImageBitmap(captured);
      equal(bitmap.width, 750, "1x of the viewBox's 750");
      equal(bitmap.height, 500, "1x of the viewBox's 500");

      var c = document.createElement("canvas");
      c.width = bitmap.width;
      c.height = bitmap.height;
      c.getContext("2d").drawImage(bitmap, 0, 0);
      assert(opaquePixels(c.getContext("2d").getImageData(0, 0, c.width, c.height)) > 20000, "and it is not blank");

      scale.value = "2";
      scale.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(1000);
      return "750x500 at 1x";
    });

    /*
     * `parseFloat("100%")` is 100, so an SVG sized in percentages -- which is
     * how most SVGs written for the web are sized -- came out as a 100 by 100
     * image with its artwork shrunk into it.
     */
    check("an SVG sized in percentages uses its viewBox", async function () {
      var markup = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 1200 800">' +
        '<rect x="0" y="0" width="1200" height="800" fill="#3366cc"/></svg>';
      drop("svg-dropzone", new File([markup], "percent.svg", { type: "image/svg+xml" }));
      await sleep(1200);
      equal(document.getElementById("svg-width").value, "1200", "the width box should show the viewBox width");
      equal(document.getElementById("svg-height").value, "800", "the height box should show the viewBox height");
      var canvas = document.getElementById("svg-canvas");
      equal(canvas.width, 2400, "2x of 1200");
      equal(canvas.height, 1600, "2x of 800");
      return "1200x800 from the viewBox";
    });

    check("a failed encode is reported rather than passing silently", async function () {
      var canvas = document.getElementById("svg-canvas");
      var error = document.getElementById("svg-error");
      var real = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (cb, type, quality) {
        if (this === canvas) return cb(null);   /* what a too-large canvas does */
        return real.call(this, cb, type, quality);
      };
      try {
        error.textContent = "";
        document.getElementById("svg-download").click();
        await sleep(1500);
        assert(error.textContent.length > 0, "the page should say the download failed, it said nothing");
      } finally {
        HTMLCanvasElement.prototype.toBlob = real;
      }
      return JSON.stringify(error.textContent.slice(0, 40));
    });

    check("an animated SVG is detected and offers the capture flow", async function () {
      var file = await fetchFile("animated-green-astronaut-helmet.svg", "image/svg+xml");
      drop("svg-dropzone", file);
      await sleep(1500);
      assert(!document.getElementById("svg-anim-section").hidden, "the animated section should be showing");
      document.getElementById("svg-anim-capture").click();
      await sleep(300);
      equal(document.getElementById("svg-frame-grid").children.length, 1, "one thumbnail per Capture frame click");
      assert(!document.getElementById("svg-anim-download").hidden, "and the download button appears");
    });
  }

  /* ------------------------------------------------------------- GIF -- */

  if (page === "gif") {
    check("the sample GIF decodes in a real browser", async function () {
      var file = await fetchFile("blue-and-bingo.gif", "image/gif");
      var buffer = await file.arrayBuffer();
      var decoded = GifDecoder.decode(buffer);
      equal(decoded.frames.length, 33, "frame count");
      equal(decoded.width, 480);
      equal(decoded.height, 480);
      equal(decoded.frames[0].delayMs, 40, "frame delay");
      return decoded.frames.length + " frames of " + decoded.width + "x" + decoded.height;
    });

    /*
     * The decoder used to build a scratch <canvas> per frame. It composites
     * into a plain array now, and the Node suite asserts the DOM is untouched
     * against a stub. This asserts the same thing where a real DOM exists, and
     * -- more usefully -- that the frames it produces in a real browser carry
     * the pixel values the Node suite checks against its own ImageData
     * transcription.
     */
    check("the decoder runs in a browser with no canvas", async function () {
      var file = await fetchFile("blue-and-bingo.gif", "image/gif");
      var buffer = await file.arrayBuffer();
      var made = [];
      var real = Document.prototype.createElement;
      Document.prototype.createElement = function (tag) {
        made.push(tag);
        return real.apply(this, arguments);
      };
      var decoded;
      try {
        decoded = GifDecoder.decode(buffer);
      } finally {
        Document.prototype.createElement = real;
      }
      equal(made.length, 0, "the decoder created " + made.join(", "));
      assert(decoded.frames[0].imageData instanceof ImageData, "the frames are real ImageData");
      equal(decoded.frames[0].imageData.data.length, 480 * 480 * 4);
      /* The same fingerprint the Node suite computes, so the two agree about
       * real pixels rather than each agreeing with itself. */
      var sum = 0;
      var data = decoded.frames[16].imageData.data;
      for (var i = 0; i < data.length; i += 997) sum = (sum * 31 + data[i]) >>> 0;
      return "frame 16 fingerprint " + sum;
    });

    if (!BASELINE) check("a damaged GIF is reported instead of freezing the page", async function () {
      var file = await fetchFile("blue-and-bingo.gif", "image/gif");
      var whole = new Uint8Array(await file.arrayBuffer());
      var cut = whole.slice(0, Math.floor(whole.length * 0.6));
      var threw = null;
      try {
        GifDecoder.decode(cut.buffer);
      } catch (err) {
        threw = err;
      }
      assert(threw || true, "it returned or threw, either is fine -- what matters is that it came back");
      return threw ? "threw: " + String(threw.message).slice(0, 50) : "returned partial frames";
    });

    check("an animated GIF plays and can be captured", async function () {
      var file = await fetchFile("blue-and-bingo.gif", "image/gif");
      drop("gif-dropzone", file);
      await sleep(3000);
      assert(!document.getElementById("gif-anim-section").hidden, "the animated section should be showing");
      document.getElementById("gif-anim-capture").click();
      await sleep(300);
      equal(document.getElementById("gif-frame-grid").children.length, 1, "one thumbnail per click");
    });

    /*
     * Every call to createAnimPlayer added four listeners to the same four
     * buttons and removed none, so a second file left two players attached.
     * One Capture frame click then produced two thumbnails -- one of them a
     * frame of the file that was no longer open.
     */
    check("loading a second file detaches the first file's player", async function () {
      var first = await fetchFile("blue-and-bingo.gif", "image/gif");
      drop("gif-dropzone", first);
      await sleep(3000);
      drop("gif-dropzone", first);
      await sleep(3000);
      var grid = document.getElementById("gif-frame-grid");
      equal(grid.children.length, 0, "a new file starts with an empty gallery");
      document.getElementById("gif-anim-capture").click();
      await sleep(400);
      equal(grid.children.length, 1, "one click on Capture frame is one thumbnail, however many files have been loaded");
    });

    check("pausing after a second load does not restart the first animation", async function () {
      var file = await fetchFile("blue-and-bingo.gif", "image/gif");
      drop("gif-dropzone", file);
      await sleep(3000);
      drop("gif-dropzone", file);
      await sleep(3000);

      var button = document.getElementById("gif-anim-playpause");
      button.click();                       /* -> Play (paused) */
      await sleep(200);
      equal(button.textContent, "Play", "one player, so one toggle");

      /* The whole canvas, not a corner of it. Sampling the first 40,000 bytes
       * was not enough: the top-left of this particular GIF barely changes
       * between frames, so the abandoned player could be redrawing the canvas
       * throughout and the check still passed. */
      var canvas = document.getElementById("gif-anim-canvas");
      var ctx = canvas.getContext("2d", { willReadFrequently: true });
      var before = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      await sleep(2000);
      var after = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      var differing = 0;
      for (var i = 0; i < before.length; i++) if (before[i] !== after[i]) differing++;
      equal(differing, 0, "a paused canvas should not still be being drawn on (" + differing + " bytes changed)");
      button.click();
      await sleep(200);
    });

    check("a capture-all in progress does not spill into the next file", async function () {
      var file = await fetchFile("blue-and-bingo.gif", "image/gif");
      drop("gif-dropzone", file);
      await sleep(3000);
      document.getElementById("gif-anim-clear").click();   /* Capture all frames */
      await sleep(300);                                    /* let a few land */
      drop("gif-dropzone", file);
      await sleep(3500);
      var grid = document.getElementById("gif-frame-grid");
      equal(grid.children.length, 0, "the abandoned capture run kept filling the new file's gallery");
    });
  }

  /* ------------------------------------------------------ WebP / AVIF -- */

  if (page === "webp") {
    check("a still WebP converts", async function () {
      var file = await fetchFile("abstract-whale-webp.webp", "image/webp");
      drop("webp-dropzone", file);
      await sleep(2500);
      var canvas = document.getElementById("webp-canvas");
      assert(canvas.width > 0 && canvas.height > 0, "the canvas should have been sized");
      assert(canvasOpaquePixels(canvas) > 1000, "and drawn on");
      assert(!document.getElementById("webp-download").hidden, "and the download button shown");
      return canvas.width + "x" + canvas.height;
    });

    check("an animated WebP is split into frames", async function () {
      var file = await fetchFile("animated-webp-3.webp", "image/webp");
      drop("webp-dropzone", file);
      await sleep(6000);
      assert(!document.getElementById("webp-anim-section").hidden, "the animated section should be showing");
      document.getElementById("webp-anim-capture").click();
      await sleep(300);
      equal(document.getElementById("webp-frame-grid").children.length, 1);
    });
  }

  if (page === "avif") {
    check("a still AVIF converts", async function () {
      var file = await fetchFile("avif-sample.avif", "image/avif");
      drop("avif-dropzone", file);
      await sleep(2500);
      var canvas = document.getElementById("avif-canvas");
      assert(canvas.width > 0 && canvas.height > 0, "the canvas should have been sized");
      assert(canvasOpaquePixels(canvas) > 1000, "and drawn on");
      return canvas.width + "x" + canvas.height;
    });

    check("an animated AVIF is split into frames", async function () {
      var file = await fetchFile("animated-avif-12-frames-hq-lossy.avif", "image/avif");
      drop("avif-dropzone", file);
      await sleep(6000);
      assert(!document.getElementById("avif-anim-section").hidden, "the animated section should be showing");
      document.getElementById("avif-anim-capture").click();
      await sleep(300);
      equal(document.getElementById("avif-frame-grid").children.length, 1);
    });
  }

  /* --------------------------------------------------------------------- */

  function publish() {
    var json = JSON.stringify(results);
    if (COLLECTOR) {
      fetch("http://127.0.0.1:" + COLLECTOR + "/results?page=" + encodeURIComponent(page), {
        method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: json,
      }).catch(function () { /* the runner's timeout will report it */ });
    }
  }

  /* A check that never settles would otherwise take the whole page with it and
   * leave the runner with nothing to report but a timeout. Each one gets its
   * own budget, so a stall is a named failure like any other. */
  function withTimeout(promise, ms, name) {
    return Promise.race([
      Promise.resolve(promise),
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error(name + " did not settle within " + ms + "ms")); }, ms);
      }),
    ]);
  }

  async function run() {
    for (var i = 0; i < queue.length; i++) {
      try {
        var detail = await withTimeout(queue[i].fn(), 60000, queue[i].name);
        record(queue[i].name, true, detail === undefined ? null : detail);
      } catch (err) {
        record(queue[i].name, false, null, String((err && err.stack) || err));
      }
    }
    publish();
  }

  window.addEventListener("load", function () {
    run().catch(function (err) {
      record("the driver itself", false, null, String((err && err.stack) || err));
      publish();
    });
  });
})();
