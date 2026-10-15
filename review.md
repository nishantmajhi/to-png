# Code Review — To PNG

**Remediated 2026-09-26 on branch `cleanup/2026-09-26`.** This file is now a
record rather than a to-do list: what was wrong, what was fixed, what was
deliberately left, and what the first review got wrong. The original review of
2026-09-04 follows under "The first review", unedited.

---

## Corrections to the first review

Two of its statements were wrong, and one of them was wrong in the direction
that matters — it praised the thing that was broken.

**"Path traversal is handled correctly in `server.js:39-40` — decode, join,
`path.normalize`, then check the resolved path still starts with the base
directory. Right order, right check."** The order is right. The check is not.
`resolved.startsWith(base)` is a string comparison wearing the clothes of a
path comparison: any sibling directory whose name merely *begins* with
"public" satisfies it. A real directory named `public-secret` beside `public/`
was created, a file put in it, and `GET /../public-secret/leak.txt` answered
**200 with the file in it**. The fix is `base + path.sep`, and there is a
regression test that builds the sibling directory and asks for the file.

**"`GifDecoder.decode` is pure — bytes in, frames out."** It was not pure: it
created a `<canvas>` per frame and relied on the browser to composite, which is
exactly why it had never been tested. It is pure now, and the suite asserts it
by handing the decoder a DOM stub that records every call and requiring the
count to be zero.

A third thing is not an error so much as an absence. The review found two P2s
and five P3s and described the project as "well-made". It is well-made. It also
had **three defects serious enough to make a headline feature not work at all**,
and the review named none of them: the default page's Download button produced
a blank PNG, a truncated GIF froze the tab, and one malformed URL killed the
server. Two of the three are on lines the review quotes approvingly.

What the review got right and is worth recording, because I nearly recorded the
opposite: **the frame-disposal handling is correct.** Six of the first fixtures
I built decoded to rubbish and it looked like six decoder bugs. The fault was in
my fixture builder, which emitted fixed-width LZW codes at a minimum code size
of 2 — where the dictionary reaches `1 << width` after two pixels and the code
width has to grow. The decoder was right and the test was wrong. The note is at
the top of `tests/gifbuild.js`.

---

## What was fixed

Sixteen defects. Every one was reproduced against the original code before it
was changed.

### The three that stopped something working

**1. P1 — the SVG Download button produced a blank PNG. Always.** This is the
default page of the tool and its most-used button.

`renderStatic()` sets `canvas.width`, which resets the canvas bitmap to
transparent black — the HTML specification requires that even when the value
assigned is the one already there, and Chrome does it. It then draws
asynchronously, in an `<img>` load handler. The download button called
`renderStatic()` and then called `triggerPngDownload()` on the very next line,
and `toBlob` snapshots the canvas immediately. So every download snapshotted a
canvas that had just been cleared and not yet redrawn.

Measured in a real Chrome against the original: **1,061,424 opaque pixels on
the canvas before the click, 0 at the instant `toBlob` ran, and 1,061,424 again
a second and a half later.** The saved PNG has 0 opaque pixels in it. The
preview above the button was correct the whole time, which is presumably why
this survived: the screen showed the right thing and the file did not.

`renderStatic` returns a promise now and the download waits for it.
`tests/browser/driver.js` asserts both the snapshot and the decoded contents of
the saved file.

**2. P1 — a truncated GIF froze the tab.** `readSubBlocks` walked the sub-block
chain with `pos += len + 1` and stopped only on a zero-length block. Past the
end of the buffer `len` is `undefined`, `undefined + 1` is `NaN`, `pos` becomes
`NaN` and stays `NaN`, and `data[NaN]` is `undefined` forever — while the loop
pushes an empty array on every iteration.

It did not throw. It allocated until the process died: under Node, an
out-of-memory abort in about a second; in a browser, a tab that stops
responding. The `try { GifDecoder.decode(...) }` in `gif.js` **cannot catch
it**, because nothing is thrown. A partial download is enough, and this is a
tool built to be handed arbitrary files. The Node suite could not be run
against the original at all until those three checks were skipped — the process
died before reaching the rest.

Every read is bounds-checked now. A file that runs out part way keeps the
frames that did decode, as a browser does; one that yields nothing throws.

**3. P1 — one request killed the server.** `GET /%` — `decodeURIComponent`
throws `URIError` on a malformed escape, unguarded, inside the request handler,
so Node exited 1. Not a 500: the server gone, every open tab with it. `GET
/%00` is the same crash by another route — that decodes cleanly, but `fs.stat`
rejects a NUL byte in a path by throwing synchronously from the same handler.

### The rest

4. **P2 — the traversal guard.** See the correction above.

5. **P2 — the server listened on every interface.** The review found this one.
   It binds `127.0.0.1` now and honours `HOST` for deliberate sharing.

6. **P2 — loading a second animated file left the first one attached.**
   `createAnimPlayer` added four listeners to the same four buttons on every
   call and `stop()` removed none. After two files: **one click on Capture
   frame produced three thumbnails**, some of them frames of a file that was no
   longer open, and pressing Pause restarted the previous animation on the same
   canvas. Measured against the original, not reasoned about.

7. **P2 — an abandoned "Capture all frames" run kept filling the next file's
   gallery.** `stop()` cancelled the playback timer but not the 80ms capture
   chain. Load a file, press Capture all frames, load another: **87 thumbnails
   of the first file appeared in the second file's gallery.**

8. **P2 — an SVG sized in percentages exported at 100×100.** `parseFloat`
   reads `"100%"` as `100`, so the viewBox was never consulted. Sizing an SVG
   `width="100%" height="100%"` with the real dimensions in the viewBox is how
   most SVGs written for the web are sized. The artwork was scaled down into
   the small canvas rather than cropped, so it looked like a deliberate
   thumbnail rather than a bug.

9. **P2 — GIFs written with a frame delay of 1 played five times too fast.**
   Delays of 0 and 1 hundredths mean "as fast as you can" and every browser
   renders both at 100ms. `delay * 10` made 1 into 10ms, which the player's own
   `Math.max(20, ...)` floored at 20ms. The README says playback "matches the
   original timing"; for one of the two most common delay values in the format,
   it did not.

10. **P2 — a failed PNG encode did nothing at all, silently.** `toBlob` hands
    back `null` for a canvas too large to encode and throws `SecurityError`
    outright for a tainted one. `if (!blob) return;` covered the first and
    nothing covered the second. Clicking Download did nothing, with no error
    anywhere. Both are reported now, through the page's existing error line.
    This also closes the review's finding 2.

11. **P2 — an animated WebP or AVIF that `ImageDecoder` failed to decode became
    its first frame with no explanation.** The "this browser cannot split the
    frames" note appeared only when the API was missing entirely, not when it
    was present and the decode threw. Same note, both cases.

12. **P3 — `PORT=0 node server.js` printed `http://localhost:0`.** The URL was
    built from `$PORT` rather than from `server.address().port`, so the one
    value that is never the answer was the one printed.

13. **P3 — the caching was not quite HTTP.** A 304 with no ETag and no
    Cache-Control, so the next request had nothing to revalidate with; an
    unquoted entity-tag, which is not a valid entity-tag; and `If-None-Match`
    compared with a single `===`, missing a list, a `W/` prefix and `*`.

14. **P3 — a port already in use printed a twenty-line stack trace.** One line
    naming the port now.

15. **P3 — error bodies had no Content-Type**, leaving them to content
    sniffing.

16. **P3 — the LZW dictionary grew without limit.** Capped at 4096. Worth being
    exact, because it would be easy to write this up as worse than it is: a
    twelve-bit code cannot address entry 4096 or beyond, so the surplus entries
    can never change a pixel. Memory, not correctness.

---

## The test suites

There were none. There are now **89 Node checks and 19 browser checks**.

```bash
npm test                        # 89 checks, no browser needed, about 15s
npm run test:browser            # 19 more, in a real headless Chrome
npm run test:browser:original   # the same 19 against the first commit
```

Against the original code, 11 of the 26 server checks fail, 4 of 33 GIF decoder
checks fail and 3 more kill the process outright, and 10 of the 18 browser
checks that can be run against it fail — the eighteenth is the truncated-GIF
one, which is skipped in that mode because it would hang the renderer and take
every other check on the page with it. Those numbers are the point of the
exercise; a suite written after the fix and never run before it is testing
nothing.

Four things in here are worth stealing:

**`tests/gifbuild.js` builds GIF89a files byte by byte from the specification.**
The one real sample pins very little on its own — it is 33 frames of a cartoon,
and a decoder with subtly wrong disposal still produces 33 frames of something.
A two-by-two image with one disposal method set on it and every pixel known in
advance is what pins the interesting code.

**`tests/decoder-vs-original.test.js` fetches the original decoder out of git
and compares every pixel of every frame.** The decoder was rewritten — from
canvas compositing to a plain array — and "I rewrote the cleverest code in the
project and it is fine" is exactly the claim that deserves a check rather than a
paragraph. Across all four disposal methods, interlace, transparency, per-frame
colour tables, an extension block, a frame hanging off the edge and the real
33-frame sample: byte for byte identical.

**`tests/browser/run.js` posts results back rather than dumping the DOM.** The
usual `--headless=new --dump-dom --virtual-time-budget` recipe, which four other
projects in this archive use, **does not work here**, and the failure is quiet.
Virtual time fast-forwards timers but not the work they wait on, so a `toBlob`
encode or an `<img>` load that takes real milliseconds is skipped past and the
page dumps before it has finished. Everything in this suite waits on exactly
that kind of work. The runner listens on a second port and the page POSTs its
results there, so everything runs in real time.

**`tests/browser/driver.js` rewrites its results div after every check and gives
each check its own timeout.** A check that never settles then leaves a record of
how far the page got, instead of a blank page and a runner timeout. That
difference turned an undiagnosable stall into a one-line fix.

### A trap that cost three separate debugging sessions

A `node:vm` context has its own intrinsics. It bit three times in three
disguises, each of which presents as a defect in the code under test:

- `ArrayBuffer.isView(x)`, not `x instanceof Uint8ClampedArray` — the
  instanceof is false for an array allocated inside the context, which sent
  `ImageData` construction down the wrong branch and produced a NaN-by-NaN
  image.
- `Object.prototype.toString.call(err) === "[object Error]"`, not
  `err instanceof Error`.
- `deepStrictEqual` compares prototypes, so `{ w: 750, h: 500 }` returned from
  the context is not deep-equal to `{ w: 750, h: 500 }` written in the test.
  Spread it, or `Array.from` it, first.

`Web/Node/Kiln` records the same trap from the other side — a library branching
on `instanceof Array` inside a `vm`. It is worth reading before writing a vm
harness.

---

## What was deliberately left alone

**No `LICENSE`.** The review asked for one. Choosing a licence is the author's
decision, not a session's, and the archive's standing rule says so. The README
states plainly that none is chosen.

**`samples/` licensing is unreviewed.** Seven media files gathered from
elsewhere. Same shape as the fonts in `Swing/Lipi`, much smaller: they are test
fixtures, not redistributed content, and the repository has no public remote
configured beyond `origin/main`. Noted in the README, not acted on.

**The UI is untouched.** No layout, styling, copy or interaction changed. Two
new error strings appear in the page's existing error line, in cases where it
previously showed nothing at all — that is a silent failure being given a
voice, not a redesign.

**The review's item 6, a frame-count warning before capturing all frames,**
would be new copy in the interface. Left. The allocation it warns about is
smaller than it sounds anyway: every frame is already decoded and in memory
before the button can be pressed, and capture only adds thumbnails.

**The review's item 7, the four nearly-parallel converter scripts.** Partly
done: the two byte-sniffers were identical and are now one tested function in
`logic.js`, as are the SVG sizing decisions. The remaining duplication is
between `svg.js`'s capture flow and `shared.js`'s, and the two are not the same
thing — SVG has continuous playback with no frame list and samples the canvas
on a timer, while the other three step through a decoded array. Merging them
would mean inventing an abstraction over two genuinely different mechanisms to
save about sixty lines. Not worth it, and it would touch the animated preview,
which is the part of this project most likely to break invisibly.

**A `.gitignore`.** There is nothing to ignore: no dependencies, no build, no
generated output.

---

## Notes for a future session

`node server.js`, then <http://localhost:3000>. `npm test` needs nothing
installed.

`public/logic.js` is the framework-free part and the place to add anything that
decides something. `public/vendor/gif-decoder.js` is the only non-trivial
algorithm; it has no DOM in it now, so it can be exercised directly from Node,
and `tests/decoder-vs-original.test.js` will tell you immediately if a change
to it moves a pixel.

The two remaining risks are both in the animated SVG path, which is the least
testable thing here: it renders into a hidden `<img>` that the browser is really
animating and copies it to a canvas every frame. There is a comment in
`startLiveLoop` about why the `<img>` is 1×1 and transparent rather than
off-screen — Chromium pauses animations on elements far outside the viewport,
which silently froze the preview on its first frame. Do not "tidy" that.

---
---

# The first review

Reviewed 2026-09-04 against the working tree. Scope: `server.js`, `public/` (four converter pages plus
`shared.js`), `public/vendor/gif-decoder.js`, `test/` (sample media), `README.md`.

## What this project is

A local website with four converters — SVG, WebP, GIF and AVIF to PNG — each running entirely in the
browser. Animated inputs are detected, played back at real frame timing, and individual frames or
whole sequences can be captured into a gallery for download. The Node server does nothing but serve
static files, with no npm dependencies at all.

## Verdict

This is a well-made tool and the architecture is the right one: the browser already has an SVG
engine, an `ImageDecoder` API and a canvas, so the correct amount of server-side image processing is
zero. Doing it this way means gradients, filters and embedded fonts render exactly as the browser
renders them, there are no upload limits, and nothing leaves the machine.

Details that show care:

- **Path traversal is handled correctly** in `server.js:39-40` — decode, join, `path.normalize`, then
  check the resolved path still starts with the base directory. Right order, right check.
- **Zero dependencies**, server and client. For a tool people run locally, that is a real feature.
- **GIF frame disposal is handled during decoding** (clear and restore-to-previous), so captured
  frames match what a real GIF viewer shows rather than raw undisposed frames. That is the detail
  almost every hand-rolled GIF decoder gets wrong.
- **Object URLs are revoked** on both the success and error paths in `svg.js:98` and `:103`.
- Seven real sample files in `test/` covering static and animated cases in every supported format.

## Findings

**1. The server listens on all interfaces.** `server.listen(PORT, ...)` with no host argument binds
everywhere, so `public/` is exposed to the local network. There is nothing sensitive in it today, but
a tool described as local should bind to `127.0.0.1` explicitly.

**2. Rendering SVG through an `Image` and canvas has security properties worth knowing.** Loading an
SVG via a blob URL into an `Image` element means scripts inside the SVG do not execute — that is the
correct approach and presumably deliberate. Two consequences to document rather than fix:

- External references inside the SVG (`<image href="https://...">`, remote fonts) may be fetched or
  may be blocked depending on the browser, so a converted file can silently lose elements or,
  conversely, make a network request from a tool that claims to be offline.
- Canvas tainting from a cross-origin reference will make `toDataURL` throw with an unhelpful security
  error. Catch it and explain what happened.

**3. `test/` holds sample media, not tests.** Seven well-chosen fixtures with no assertions over them.
The decoder is the part that would benefit: `GifDecoder.decode` is pure — bytes in, frames out — so
asserting frame count, dimensions and per-frame delays against the known `blue-and-bingo.gif` would
pin the disposal logic that is currently the project's cleverest code. Rename the directory to
`samples/` if it stays fixtures-only, so it does not read as an untested test suite.

**4. The vendored GIF decoder has no version or provenance note.** The header says "minimal,
dependency-free GIF89a decoder" — if you wrote it, say so; if it is adapted from somewhere, record the
source and its licence. Either way a future reader needs to know whether upstream fixes exist.

**5. `ImageDecoder` is Chromium-only at present.** The WebP and AVIF animated paths depend on it, so
in Firefox or Safari those tabs will fail. Feature-detect and show a clear message rather than a
broken control, and note the browser requirement in the README.

**6. Capturing all frames of a long animation builds every frame in memory** before the user picks
one. A hundred-frame 4K GIF is a large allocation. A frame-count warning would be enough.

**7. Four nearly-parallel implementations.** `svg.js`, `webp.js`, `gif.js` and `avif.js` each
implement detect, play, pause, capture frame, capture all, and download. `shared.js` exists, so some
of it is already factored out — worth checking how much duplication remains, because a fix to the
capture logic currently has to be made four times.

**8. No `LICENSE`.**

## Cleanup

Nothing to remove. One `console.log` in `server.js` announcing the URL, which is correct behaviour.
No secrets, no analytics, no committed build output.

## Action checklist

- [x] **P2** Bind the server to `127.0.0.1`.
- [x] **P2** Feature-detect `ImageDecoder` and explain the browser requirement.
- [x] **P3** Add assertions over the GIF decoder using the existing sample; rename `test/` to
      `samples/` if it stays fixtures-only.
- [x] **P3** Record the provenance and licence of the vendored decoder.
- [~] **P3** Factor the shared capture logic out of the four converter scripts; add a `LICENSE`.
      Partly — see "What was deliberately left alone".

## Notes for a future session

`node server.js` and open the printed URL — no install step. Each format has its own page and script
under `public/`. The GIF decoder in `public/vendor/` is the only non-trivial algorithm here; its
frame-disposal handling is what makes captures correct, so treat any change there as needing the
sample GIF checked visually, frame by frame.

## Licence, 2026-10-02

The author chose one licence for all of their projects: free for personal,
non-commercial use, modifiable for the user's own use, and not to be
distributed, original or modified. No standard licence says that, so `LICENSE`
is a short custom text, the same in every project apart from the year and what
it excludes. The README's licence section says the same, and `package.json`
declares `SEE LICENSE IN LICENSE`, npm's form for a licence with no SPDX
identifier. Anything above that calls the licence an open question, or calls
the project MIT, is superseded.

## CI, 2026-10-02

`.github/workflows/ci.yml` runs the node checks and the browser suite as two
jobs on `ubuntu-latest`. Nothing has been pushed, so it has not run on GitHub
yet. Every job was run before committing, from a fresh clone of this branch,
the way a runner would run it: Linux jobs in a throwaway Ubuntu 24.04 (the
image `ubuntu-latest` uses) with the same tool versions. 89 and 19.

The node job fetches full history: without it the 6 decoder-versus-original
checks skip. The browser job fails if the runner prints `SKIP`, which it does
when it finds no Chrome; otherwise a missing browser would read as a pass.
