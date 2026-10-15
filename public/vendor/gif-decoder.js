/**
 * Minimal, dependency-free GIF89a decoder. Written for this project; not
 * adapted from an existing library, so there is no upstream to take fixes
 * from and no third-party licence attached to it.
 *
 * Exposes: window.GifDecoder.decode(arrayBuffer)
 *   -> { width, height, frames: [ { imageData, delayMs } ] }
 *
 * Each frame's imageData is the FULL, already-composited canvas frame (i.e.
 * exactly what a GIF player would show on screen at that point), with disposal
 * methods (none / restore-to-background / restore-to-previous) already
 * applied. That means any frame can be exported on its own with correct
 * results.
 *
 * Damaged input throws an Error naming what went wrong. It used to hang: the
 * sub-block walk ran off the end of the buffer and looped forever allocating,
 * which is a frozen tab and is not something the caller's try/catch can see.
 * A file that runs out part way through keeps the frames that did decode,
 * which is what a browser does with the same file.
 *
 * Nothing here touches the DOM. It composites into a plain array and builds
 * ImageData at the end, so it can be tested outside a browser -- which is why
 * it now is.
 */
(function (global) {
  'use strict';

  var MAX_DICT_ENTRIES = 4096; // a GIF LZW code is at most 12 bits

  function TruncatedError(what) {
    return new Error('This GIF is truncated or damaged (' + what + ').');
  }

  function GifReader(buf) {
    this.data = new Uint8Array(buf);
    this.pos = 0;
  }
  GifReader.prototype.need = function (n, what) {
    if (this.pos + n > this.data.length) throw TruncatedError('ran out of bytes reading the ' + what);
  };
  GifReader.prototype.u8 = function (what) {
    this.need(1, what || 'next byte');
    return this.data[this.pos++];
  };
  GifReader.prototype.u16 = function (what) {
    this.need(2, what || 'next value');
    var v = this.data[this.pos] | (this.data[this.pos + 1] << 8);
    this.pos += 2;
    return v;
  };
  GifReader.prototype.bytes = function (n, what) {
    this.need(n, what || 'next ' + n + ' bytes');
    var out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  };
  // Concatenates GIF data sub-blocks until a zero-length block terminator.
  //
  // The bounds check is the whole point of this function's history. Without
  // it, `len` past the end of the buffer is undefined, `pos += len + 1` makes
  // pos NaN, and NaN indexes nothing forever -- so a GIF missing its last few
  // bytes did not fail, it allocated an empty array per iteration until the
  // process died. Nothing was thrown, so `gif.js` could not catch it and the
  // tab simply stopped responding.
  GifReader.prototype.readSubBlocks = function () {
    var pos = this.pos;
    var blocks = [];
    var total = 0;
    for (;;) {
      if (pos >= this.data.length) throw TruncatedError('no block terminator');
      var len = this.data[pos];
      if (len === 0) { pos += 1; break; }
      if (pos + 1 + len > this.data.length) throw TruncatedError('a data block runs past the end');
      blocks.push(this.data.subarray(pos + 1, pos + 1 + len));
      total += len;
      pos += len + 1;
    }
    var out = new Uint8Array(total);
    var off = 0;
    for (var i = 0; i < blocks.length; i++) { out.set(blocks[i], off); off += blocks[i].length; }
    this.pos = pos;
    return out;
  };

  function parseColorTable(reader, count) {
    var raw = reader.bytes(count * 3, 'colour table');
    var table = new Array(count);
    for (var i = 0; i < count; i++) {
      table[i] = [raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]];
    }
    return table;
  }

  // Standard GIF LZW decompression -> array of color-table indices.
  function lzwDecode(minCodeSize, data) {
    var CLEAR = 1 << minCodeSize;
    var END = CLEAR + 1;
    var codeSize = minCodeSize + 1;
    var dict = [];

    function resetDict() {
      dict = [];
      for (var i = 0; i < CLEAR; i++) dict[i] = [i];
      dict[CLEAR] = [];
      dict[END] = null;
      codeSize = minCodeSize + 1;
    }
    resetDict();

    var output = [];
    var bitBuf = 0, bitLen = 0, pos = 0;
    var prev = null;

    // Returns -1 when the stream runs out mid-code rather than reading
    // `undefined` and shifting zeroes in.
    function readCode() {
      while (bitLen < codeSize) {
        if (pos >= data.length) return -1;
        bitBuf |= data[pos++] << bitLen;
        bitLen += 8;
      }
      var code = bitBuf & ((1 << codeSize) - 1);
      bitBuf >>= codeSize;
      bitLen -= codeSize;
      return code;
    }

    for (;;) {
      var code = readCode();
      if (code === -1) break;
      if (code === CLEAR) { resetDict(); prev = null; continue; }
      if (code === END) break;

      var entry;
      if (dict[code]) {
        entry = dict[code];
      } else if (code === dict.length && prev) {
        entry = prev.concat([prev[0]]);
      } else {
        break; // corrupt stream, stop gracefully
      }

      for (var i = 0; i < entry.length; i++) output.push(entry[i]);

      if (prev) {
        // A twelve-bit code cannot address entry 4096 or beyond, so growing
        // past the ceiling can only consume memory -- on a long stream, a
        // great deal of it.
        if (dict.length < MAX_DICT_ENTRIES) {
          dict.push(prev.concat([entry[0]]));
          if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++;
        }
      }
      prev = entry;
    }
    return output;
  }

  // Interlaced GIF pass order: every 8th starting at 0, every 8th starting
  // at 4, every 4th starting at 2, every 2nd starting at 1.
  function buildRowOrder(height, interlaced) {
    var rows = [];
    var i;
    if (!interlaced) {
      for (i = 0; i < height; i++) rows.push(i);
      return rows;
    }
    var passes = [[0, 8], [4, 8], [2, 4], [1, 2]];
    for (var p = 0; p < passes.length; p++) {
      for (i = passes[p][0]; i < height; i += passes[p][1]) rows.push(i);
    }
    return rows;
  }

  // Every browser renders a stored delay of 0 or 1 hundredths -- the
  // conventional "as fast as possible" -- at 100ms, and a GIF written with a
  // delay of 1 is very common. Following the file literally there would play
  // it ten times too fast, which is not what this tool's live preview is for.
  function delayToMs(rawHundredths) {
    return rawHundredths <= 1 ? 100 : rawHundredths * 10;
  }

  function decode(arrayBuffer) {
    var reader = new GifReader(arrayBuffer);
    if (reader.data.length < 13) throw new Error('Not a GIF file (too short to be one).');

    var sig = String.fromCharCode.apply(null, reader.bytes(6, 'signature'));
    if (sig !== 'GIF87a' && sig !== 'GIF89a') {
      throw new Error('Not a GIF file');
    }

    var width = reader.u16('screen width');
    var height = reader.u16('screen height');
    var packed = reader.u8('screen descriptor');
    var gctFlag = (packed & 0x80) !== 0;
    var gctSize = 2 << (packed & 0x07);
    reader.u8('background colour index');
    reader.u8('pixel aspect ratio');

    if (width <= 0 || height <= 0) throw new Error('This GIF declares a zero-sized screen.');

    var globalColorTable = null;
    if (gctFlag) globalColorTable = parseColorTable(reader, gctSize);

    // The compositing surface, persisting across frames: RGBA, one byte per
    // channel, in the same layout as ImageData so a frame is one copy away.
    var composite = new Uint8ClampedArray(width * height * 4);

    var prevSnapshot = null;   // for disposal method 3 (restore to previous)
    var prevRegion = null;     // {x,y,w,h} of previous frame, for disposal 2/3
    var prevDisposal = 0;

    var gce = { delay: 0, transparentIndex: -1, disposal: 0 };
    var frames = [];

    // A damaged file keeps whatever decoded before the damage, the way a
    // browser shows the frames it managed to read. Only a file that yielded
    // nothing at all is an error the caller has to be told about -- and it has
    // to be, because `gif.js` reads frames[0] whenever there is one frame.
    try {
      decodeFrames();
    } catch (err) {
      if (frames.length === 0) throw err;
    }

    function clearRegion(region) {
      var x0 = Math.max(0, region.x);
      var y0 = Math.max(0, region.y);
      var x1 = Math.min(width, region.x + region.w);
      var y1 = Math.min(height, region.y + region.h);
      for (var y = y0; y < y1; y++) {
        var row = y * width * 4;
        for (var x = x0; x < x1; x++) {
          var d = row + x * 4;
          composite[d] = composite[d + 1] = composite[d + 2] = composite[d + 3] = 0;
        }
      }
    }

    function decodeFrames() {
      while (reader.pos < reader.data.length) {
        var blockType = reader.u8('block type');

        if (blockType === 0x21) { // Extension
          var label = reader.u8('extension label');
          if (label === 0xF9) { // Graphic Control Extension
            reader.u8('GCE block size');
            var flags = reader.u8('GCE flags');
            var delay = reader.u16('GCE delay');
            var transparentIndex = reader.u8('GCE transparent index');
            reader.u8('GCE terminator');
            gce = {
              delay: delay,
              transparentIndex: (flags & 0x01) ? transparentIndex : -1,
              disposal: (flags >> 2) & 0x07,
            };
          } else {
            reader.readSubBlocks(); // skip other extensions (app, comment)
          }
        } else if (blockType === 0x2C) { // Image Descriptor
          var left = reader.u16('frame left');
          var top = reader.u16('frame top');
          var w = reader.u16('frame width');
          var h = reader.u16('frame height');
          var ipacked = reader.u8('frame flags');
          var localFlag = (ipacked & 0x80) !== 0;
          var interlaced = (ipacked & 0x40) !== 0;
          var localSize = 2 << (ipacked & 0x07);

          var colorTable = globalColorTable;
          if (localFlag) colorTable = parseColorTable(reader, localSize);
          if (!colorTable) {
            throw new Error('This GIF has no colour table, neither global nor per-frame.');
          }

          var minCodeSize = reader.u8('LZW minimum code size');
          if (minCodeSize < 2 || minCodeSize > 8) {
            throw new Error('This GIF declares an impossible LZW code size (' + minCodeSize + ').');
          }
          var imgData = reader.readSubBlocks();
          var indices = lzwDecode(minCodeSize, imgData);

          // Apply disposal of the PREVIOUS frame before drawing this one.
          if (prevDisposal === 2 && prevRegion) {
            clearRegion(prevRegion);
          } else if (prevDisposal === 3 && prevSnapshot) {
            composite.set(prevSnapshot);
          }
          // disposal 0/1: leave composite as-is (do nothing)

          // Snapshot BEFORE drawing current frame, in case ITS disposal is 3.
          var snapshotForThisFrame = new Uint8ClampedArray(composite);

          // Composite this frame's rect straight onto the surface, handling
          // interlace and transparency. A transparent index means "leave what
          // is underneath", which is what the old scratch-canvas drawImage was
          // buying; done directly it is one pass instead of three and needs no
          // DOM.
          var rows = buildRowOrder(h, interlaced);
          var idx = 0;
          for (var r = 0; r < rows.length; r++) {
            var y = top + rows[r];
            var rowBase = y * width * 4;
            var inRow = y >= 0 && y < height;
            for (var x = 0; x < w; x++) {
              var colorIndex = indices[idx++];
              if (!inRow) continue;
              var tx = left + x;
              if (tx < 0 || tx >= width) continue;
              if (colorIndex === undefined) continue;   // stream ended early
              if (colorIndex === gce.transparentIndex) continue;
              var rgb = colorTable[colorIndex];
              if (!rgb) continue;                       // index outside the table
              var d = rowBase + tx * 4;
              composite[d] = rgb[0];
              composite[d + 1] = rgb[1];
              composite[d + 2] = rgb[2];
              composite[d + 3] = 255;
            }
          }

          frames.push({
            imageData: new ImageData(new Uint8ClampedArray(composite), width, height),
            delayMs: delayToMs(gce.delay),
          });

          prevSnapshot = snapshotForThisFrame;
          prevRegion = { x: left, y: top, w: w, h: h };
          prevDisposal = gce.disposal;
          gce = { delay: 0, transparentIndex: -1, disposal: 0 };
        } else if (blockType === 0x3B) { // Trailer
          break;
        } else {
          break; // unknown/corrupt block, stop gracefully
        }
      }
    }

    if (frames.length === 0) {
      throw new Error('This GIF contains no image frames.');
    }

    return { width: width, height: height, frames: frames };
  }

  global.GifDecoder = { decode: decode };
})(typeof window !== 'undefined' ? window : globalThis);
