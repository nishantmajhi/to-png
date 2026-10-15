"use strict";

/*
 * Builds GIF89a files byte by byte, from the specification rather than from
 * the decoder.
 *
 * The one real sample in `samples/` pins nothing on its own: it is 33 frames
 * of a cartoon, and a decoder that got disposal or interlace subtly wrong
 * would still produce 33 frames of something. What pins the interesting code
 * is a two-by-two image whose every pixel is known in advance, with one
 * disposal method set on it.
 *
 * The LZW here is the "uncompressed" form every GIF writer falls back to: a
 * CLEAR code, then one code per pixel, with another CLEAR inserted often
 * enough that the dictionary never grows far enough to widen the code. That
 * is legal GIF and it means nothing in this file has to agree with the
 * decoder's dictionary handling for the fixture to be valid -- which matters,
 * because the decoder's dictionary handling is one of the things being tested.
 */

/* LSB-first bit packer, which is the order GIF's LZW codes are written in. */
class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.n = 0;
  }
  write(code, width) {
    this.acc |= code << this.n;
    this.n += width;
    while (this.n >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>= 8;
      this.n -= 8;
    }
  }
  finish() {
    if (this.n > 0) this.bytes.push(this.acc & 0xff);
    this.n = 0;
    this.acc = 0;
    return this.bytes;
  }
}

/*
 * The fixed-width form. A CLEAR, then one nine-bit code per pixel, with
 * another CLEAR every hundred codes.
 *
 * It only works at minCodeSize 8, and the reason is worth writing down because
 * getting it wrong here looked exactly like six decoder bugs. The decoder adds
 * a dictionary entry for every code after the first, and widens the code as
 * soon as the dictionary reaches 1 << width. At minCodeSize 2 that is after
 * two pixels -- so a writer emitting everything at three bits desynchronises
 * immediately, and every fixture with more than two pixels in it decodes to
 * rubbish through no fault of the decoder. At minCodeSize 8 the dictionary
 * starts at 258 and does not reach 512 for another 254 codes, so a CLEAR every
 * hundred keeps the width at nine for good. Hence: palettes here are always
 * padded to 256 entries.
 */
function lzwEncodeUncompressed(indices, minCodeSize) {
  if (minCodeSize !== 8) throw new Error("the fixed-width writer is only valid at minCodeSize 8");
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const width = minCodeSize + 1;
  const w = new BitWriter();

  w.write(clear, width);
  let since = 0;
  for (const index of indices) {
    if (since >= 100) {
      w.write(clear, width);
      since = 0;
    }
    w.write(index, width);
    since++;
  }
  w.write(end, width);
  return w.finish();
}

/*
 * The growing form: one CLEAR at the start and never another, so the code
 * width climbs 9, 10, 11, 12 exactly as the specification says it must, and a
 * long enough frame drives the dictionary to its 4096-entry ceiling. Only root
 * codes are emitted, which is always legal whatever the dictionary holds, so
 * nothing here depends on the decoder's dictionary agreeing with a
 * hypothetical encoder's -- only on the width rule, which is the thing being
 * exercised.
 */
function lzwEncodeGrowing(indices, minCodeSize) {
  if (minCodeSize !== 8) throw new Error("the growing writer is only valid at minCodeSize 8");
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const w = new BitWriter();

  let width = minCodeSize + 1;
  let entries = clear + 2;
  w.write(clear, width);

  indices.forEach((index, i) => {
    w.write(index, width);
    if (i === 0) return;              /* the first code after a CLEAR defines nothing */
    if (entries < 4096) {
      entries++;
      if (entries === (1 << width) && width < 12) width++;
    }
  });
  w.write(end, width);
  return w.finish();
}

function subBlocks(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

function u16(v) {
  return [v & 0xff, (v >> 8) & 0xff];
}

/* Always 256 entries -- see the note on lzwEncodeUncompressed for why the
 * writers here are only correct at a minimum code size of 8. */
function paddedPalette(colours) {
  const size = 256;
  if (colours.length > size) throw new Error("a GIF colour table holds at most 256 entries");
  const out = [];
  for (let i = 0; i < size; i++) {
    const c = colours[i] || [0, 0, 0];
    out.push(c[0], c[1], c[2]);
  }
  return { bytes: out, bits: Math.log2(size) - 1, size };
}

/*
 * frames: [{
 *   indices, width, height,     // the frame's own pixel rect
 *   left, top,                  // where it sits on the logical screen
 *   delayRaw,                   // hundredths of a second, as stored
 *   disposal,                   // 0..3
 *   transparentIndex,           // or undefined for none
 *   interlaced,                 // lay the rows out in GIF's four passes
 *   palette,                    // a local colour table, or undefined
 * }]
 */
function buildGif({ width, height, palette, frames, trailer = true, loop = false }) {
  const global = paddedPalette(palette);
  const bytes = [];
  const push = (...v) => bytes.push(...v.flat());

  push([...Buffer.from("GIF89a", "ascii")]);
  push(u16(width), u16(height));
  push(0x80 | global.bits); /* global table present, of this size */
  push(0x00); /* background colour index */
  push(0x00); /* pixel aspect ratio */
  push(global.bytes);

  if (loop) {
    /* NETSCAPE2.0, the one application extension that is everywhere. It is
     * here so the "unknown extensions are skipped" path is exercised by a
     * real block rather than an invented one. */
    push(0x21, 0xff, 0x0b);
    push([...Buffer.from("NETSCAPE2.0", "ascii")]);
    push(0x03, 0x01, 0x00, 0x00, 0x00);
  }

  for (const f of frames) {
    const local = f.palette ? paddedPalette(f.palette) : null;
    const minCodeSize = Math.max(2, (local || global).bits + 1);

    push(0x21, 0xf9, 0x04);
    push(((f.disposal || 0) << 2) | (f.transparentIndex === undefined ? 0 : 1));
    push(u16(f.delayRaw || 0));
    push(f.transparentIndex === undefined ? 0 : f.transparentIndex);
    push(0x00);

    push(0x2c);
    push(u16(f.left || 0), u16(f.top || 0));
    push(u16(f.width), u16(f.height));
    push((local ? 0x80 | local.bits : 0) | (f.interlaced ? 0x40 : 0));
    if (local) push(local.bytes);

    const ordered = f.interlaced ? interlace(f.indices, f.width, f.height) : f.indices;
    const encode = f.growingCodes ? lzwEncodeGrowing : lzwEncodeUncompressed;
    push(minCodeSize);
    push(subBlocks(encode(ordered, minCodeSize)));
  }

  if (trailer) push(0x3b);
  return Buffer.from(bytes);
}

/* Reorders rows into GIF's four interlace passes, which is the layout a
 * writer produces and the decoder has to undo. */
function interlace(indices, width, height) {
  const passes = [
    { start: 0, step: 8 },
    { start: 4, step: 8 },
    { start: 2, step: 4 },
    { start: 1, step: 2 },
  ];
  const out = [];
  for (const p of passes) {
    for (let y = p.start; y < height; y += p.step) {
      for (let x = 0; x < width; x++) out.push(indices[y * width + x]);
    }
  }
  return out;
}

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

module.exports = {
  buildGif, toArrayBuffer, interlace,
  lzwEncodeUncompressed, lzwEncodeGrowing, subBlocks,
};
