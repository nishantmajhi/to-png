# To PNG

Four converters — SVG, WebP, GIF and AVIF — that turn an image into a PNG
without it leaving your computer.

The conversion happens in your browser. The Node server that comes with this
reads files off the disk and hands them to the browser; it has never seen an
image and cannot. That is not a privacy flourish, it is the whole design: the
browser already has an SVG renderer, image decoders and a canvas, so the right
amount of server-side image processing is none. It also means there is no
upload, no size limit and no daily quota.

## Run it

Node 20 or newer. There is nothing to install — no dependencies, server or
client.

```bash
node server.js
```

Then open <http://localhost:3000>, which is the SVG converter.

```bash
PORT=8080 node server.js     # a different port
PORT=0    node server.js     # any free port; it prints which one
HOST=0.0.0.0 node server.js  # let other machines on the network reach it
```

The server binds to `127.0.0.1` unless you set `HOST`. Only this machine can
reach it by default, which is what a tool with that subtitle ought to do.

## The four converters

Each lives on its own URL: `/svg`, `/webp`, `/gif`, `/avif`. Drop a file on the
page, or click browse.

**Static files** get a preview and a **Download PNG** button. One click
converts and saves.

**Animated files** are detected automatically and get a different flow: a live
preview that plays at the file's own frame timing, Play/Pause, **Capture
frame** to take the moment currently on screen into a gallery, and **Capture
all frames** to take the whole sequence at once. Pick a thumbnail, download it.

### SVG → PNG

Rendered by the browser's own SVG engine, so gradients, filters, clip paths and
embedded fonts come out exactly as they look on screen.

You choose the output size: a scale of 1x to 8x, or an exact width and height.
The size it starts from is the SVG's own `width` and `height`, or its `viewBox`
when those are missing or given as percentages — which is how most SVGs written
for the web are sized. There is an optional white background for when a
transparent PNG is not what you want.

An SVG counts as animated if it contains SMIL (`<animate>`, `<set>`) or CSS
animation (`@keyframes`, `animation:`). Animation driven from outside the file
by JavaScript cannot be detected, because it is not a property of the file.

Its live preview works by rendering the SVG into a hidden `<img>` that the
browser is really animating, and copying that onto a canvas on every frame.
Capture takes whatever is on the canvas at that instant.

### WebP → PNG

A still WebP is decoded by the browser, so if your browser can display it, this
can convert it.

An animated WebP is split into frames with the `ImageDecoder` API, and each
frame's real duration drives the preview. `ImageDecoder` is a Chromium feature
at the time of writing; in Firefox or Safari the file still converts, but only
its first frame, and the page says so.

### GIF frame → PNG

GIFs are decoded here rather than by the browser, by
`public/vendor/gif-decoder.js` — a small GIF89a decoder written for this
project. The browser will happily *display* an animated GIF but gives a page no
way to reach its individual frames, which is the one thing this converter is
for.

Every frame it hands back is a complete composited screen, with disposal
methods already applied — so a frame that in the file is a twenty-pixel patch
of a mouth moving comes out as the whole picture with that mouth, which is what
you would see in a GIF viewer and what you want in a PNG.

Frame delays of 0 or 1 hundredths of a second are rendered at 100ms, which is
what every browser does with them.

A damaged or partly downloaded GIF is reported rather than decoded. If some
frames read before the damage, those are kept, as a browser would keep them.

### AVIF → PNG

The same shape as WebP. A still AVIF (`mif1`) is decoded by the browser. An
AVIF image *sequence* (`avis`) is split into frames with `ImageDecoder`, and
falls back to the first frame with an explanation where that is unavailable.

## Layout

```
to-png/
├── server.js                 static file server; routes, MIME types, caching
├── package.json              scripts only — there are no dependencies
├── public/
│   ├── svg.html webp.html gif.html avif.html
│   ├── style.css
│   ├── logic.js              decisions with no DOM in them: is this SVG
│   │                         animated, what size should it be, is this file
│   │                         a sequence
│   ├── shared.js             dropzone, PNG download, the animated-preview
│   │                         player shared by GIF, WebP and AVIF
│   ├── svg.js webp.js gif.js avif.js
│   └── vendor/gif-decoder.js
├── samples/                  seven real files, one per interesting case
└── tests/
    ├── helpers.js            starts the real server; loads a browser script
    │                         into a vm context
    ├── gifbuild.js           builds GIF89a files byte by byte from the spec
    ├── server.test.js
    ├── logic.test.js
    ├── gif-decoder.test.js
    ├── decoder-vs-original.test.js
    └── browser/              the same pages in a real headless Chrome
```

## Tests

```bash
npm test              # 89 checks, no browser needed, about 15 seconds
npm run test:browser  # 21 more, in a real headless Chrome
```

`npm test` needs nothing installed. It starts the real server on a real socket
and makes real requests to it; it runs the GIF decoder over files built byte by
byte from the GIF89a specification, with known pixels, so that disposal and
interlace are pinned by something other than "it looked right"; and it compares
the current decoder against the original in git, frame by frame, because that
file was rewritten and a paragraph saying the rewrite is faithful is not worth
as much as a comparison.

`npm run test:browser` finds Chrome or Edge and skips with a message if there
is none. It exists for the things no model of a browser can settle — most of
all what the Download button hands to the browser, decoded back into pixels.

Both suites can be run against the code as it was:

```bash
npm run test:browser:original
```

which stages the first commit out of git and expects to fail exactly the checks
listed in `tests/browser/run.js`.

## Notes and limits

- **An SVG that references anything across the network** — a remote font, an
  `<image href="https://...">` — may or may not load it, depending on the
  browser, because the SVG is rendered from a blob URL. If it loads, the canvas
  becomes tainted and the PNG cannot be read back out; the page now says so
  instead of doing nothing. Self-contained SVGs, which is nearly all of them,
  are unaffected.
- **Animated WebP and AVIF need `ImageDecoder`**, which is Chromium-only at the
  time of writing. Elsewhere you get the first frame and a note saying why.
- **Capturing all frames of a long animation** builds a thumbnail per frame.
  A hundred-frame 4K GIF is a large allocation.
- **Very large output is clamped** to 16384 pixels on a side. Past roughly
  there a browser refuses to allocate the canvas, and the failure is silent —
  no error, just no download.
- **The GIF decoder is not a general-purpose library.** It handles GIF87a and
  GIF89a, interlace, transparency, per-frame colour tables and all four
  disposal methods, which covers every GIF anyone is likely to have. It does
  not handle the Plain Text extension, which nothing has written since about
  1995.

## Licence

Free for personal, non-commercial use. You may use, study and modify this
software for yourself, but you may not use it commercially, and you may not
share or publish it, in its original form or modified. See [LICENSE](LICENSE)
for the full terms.

The files in `samples/` are not covered: they were gathered from elsewhere
for testing, and their licensing has not been reviewed.
