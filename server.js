// server.js -- plain Node.js HTTP server, zero dependencies (no Express).
// Serves the static site in ./public. All actual conversion work
// (SVG->PNG, WebP->PNG, GIF frame->PNG, AVIF->PNG) happens client-side
// in the browser via <canvas>, so the server only needs to hand out files.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// Loopback by default. This is a local tool whose own subtitle promises that
// nothing leaves the machine, and `listen(PORT)` with no host offers the site
// to everyone on the network -- the coffee shop wifi included. Sharing it on
// purpose is still one environment variable away.
const HOST = process.env.HOST || '127.0.0.1';

const PUBLIC_DIR = path.join(__dirname, 'public');

// Custom routing (no framework): each converter now lives on its own
// clean URL instead of being a tab within one page. "/" defaults to
// the SVG converter, since that was the default active tab before.
const ROUTES = {
  '/': 'svg.html',
  '/svg': 'svg.html',
  '/webp': 'webp.html',
  '/gif': 'gif.html',
  '/avif': 'avif.html',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico':  'image/x-icon',
  '.map':  'application/json',
};

// Returns the file the request resolves to, or null if the request is one we
// will not answer.
//
// Three things can go wrong here and all three used to be a crash or a leak:
//
//   - `decodeURIComponent` throws URIError on a malformed escape, so a single
//     request for `/%` ended the process. It is caught.
//   - A NUL byte survives decoding, and `fs.stat` rejects one by throwing
//     synchronously out of the request handler -- the same crash by a
//     different route. It is rejected here.
//   - Containment was tested with `resolved.startsWith(base)`, which is a
//     string comparison dressed as a path comparison: a sibling directory
//     named `public-secret` starts with `.../public` and was served. The test
//     is against base + separator, which is what it always meant.
function safeJoin(base, requestedPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestedPath.split('?')[0]);
  } catch {
    return null;
  }
  if (decoded.indexOf('\0') !== -1) return null;

  const resolved = path.normalize(path.join(base, decoded));
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

// Compares an If-None-Match header against our entity-tag. The header may hold
// a list, each entry may carry a W/ prefix, and `*` matches anything that
// exists -- none of which the old single `===` allowed for.
function etagMatches(header, etag) {
  if (!header) return false;
  const unweaken = (t) => t.trim().replace(/^W\//, '');
  return header
    .split(',')
    .map(unweaken)
    .some((candidate) => candidate === '*' || candidate === etag);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

// Error bodies are plain text and say so, rather than being left for the
// browser to sniff.
function sendText(res, status, message) {
  send(res, status, message, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message),
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method Not Allowed');
  }

  const urlPath = req.url.split('?')[0];
  const routedFile = ROUTES[urlPath];

  const filePath = routedFile
    ? path.join(PUBLIC_DIR, routedFile)
    : safeJoin(PUBLIC_DIR, urlPath);

  if (!filePath) return sendText(res, 400, 'Bad Request');

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      return sendText(res, 404, 'Not found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) return sendText(res, 500, 'Internal Server Error');

      const etag = '"' + crypto.createHash('sha1').update(data).digest('hex') + '"';

      // A 304 has to repeat the validators, or the next request has nothing to
      // revalidate with and the cache entry is useless.
      if (etagMatches(req.headers['if-none-match'], etag)) {
        return send(res, 304, null, { 'ETag': etag, 'Cache-Control': 'no-cache' });
      }

      send(res, 200, data, {
        'Content-Type': contentType,
        'Content-Length': data.length,
        'ETag': etag,
        'Cache-Control': 'no-cache',
      });
    });
  });
});

// "EADDRINUSE" inside a twenty-line stack trace is not a useful thing to show
// someone who was told to start this by typing `node server.js`.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Start it on another one with: PORT=8080 node server.js`);
  } else if (err.code === 'EACCES') {
    console.error(`Not allowed to listen on port ${PORT}. Ports below 1024 usually need elevation.`);
  } else {
    console.error(`Could not start the server: ${err.message}`);
  }
  process.exit(1);
});

// The port that was actually bound, not the one that was asked for -- they
// differ whenever PORT is 0, which is how you ask the OS for a free one.
server.listen(PORT, HOST, () => {
  const { port } = server.address();
  const shown = HOST === '127.0.0.1' || HOST === 'localhost' ? 'localhost' : HOST;
  console.log(`To PNG running at http://${shown}:${port}`);
});
