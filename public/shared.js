// shared.js — helpers used by svg.js, webp.js and gif.js.
// All conversion still happens entirely client-side; this file just
// holds the bits that were duplicated across tabs when everything
// lived in one app.js.

function setupDropzone(zoneId, inputId, browseId, onFile) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  const browseBtn = document.getElementById(browseId);

  browseBtn.addEventListener('click', () => input.click());
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files[0]) onFile(input.files[0]);
  });

  ['dragenter', 'dragover'].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
    })
  );
  zone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  });
}

// Converts a canvas to PNG and immediately downloads it — no separate
// "convert" step, no intermediate visible link the user has to click twice.
//
// `onFailure` is called instead of the download when the PNG cannot be
// produced. Both ways that can happen used to end in nothing at all
// happening, with no error anywhere: `toBlob` yields null when the canvas is
// too large for the browser to encode, and it throws SecurityError outright
// when the canvas is tainted, which is what an SVG referencing a cross-origin
// image or font leaves behind.
function triggerPngDownload(canvas, filename, onFailure) {
  const failed = (why) => {
    if (typeof onFailure === 'function') onFailure(why);
  };
  const save = (blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  try {
    canvas.toBlob((blob) => {
      if (!blob) {
        failed('The image could not be encoded — it may be too large for this browser.');
        return;
      }
      save(blob);
    }, 'image/png');
  } catch (err) {
    failed(
      err && err.name === 'SecurityError'
        ? 'This file references an image or font from another site, which stops the browser letting the result be saved.'
        : 'The image could not be encoded: ' + (err && err.message ? err.message : String(err)),
    );
  }
}

function showError(elId, message) {
  document.getElementById(elId).textContent = message || '';
}

// Smoothly scrolls to the bottom of the page. Used after a file is
// loaded and its preview/download controls appear, so the result is
// visible without the user having to scroll down manually — useful
// since the preview and download button render below the fold on
// smaller screens once a file is dropped in.
function scrollToBottom() {
  window.scrollTo({
    top: document.body.scrollHeight,
    behavior: 'smooth',
  });
}

// Appends one thumbnail to a gallery that's built up incrementally
// (used for SVG frame capture, where frames arrive one at a time as
// the user clicks "Capture frame" during playback, rather than being
// known all at once).
function appendFrameThumbnail(gridEl, imageData, onSelect) {
  const index = gridEl.children.length;
  const thumb = document.createElement('div');
  thumb.className = 'frame-thumb';
  const c = document.createElement('canvas');
  c.width = imageData.width;
  c.height = imageData.height;
  c.getContext('2d').putImageData(imageData, 0, 0);
  const label = document.createElement('span');
  label.className = 'idx';
  label.textContent = index + 1;
  thumb.appendChild(c);
  thumb.appendChild(label);
  thumb.addEventListener('click', () => {
    gridEl.querySelectorAll('.frame-thumb.selected').forEach((el) => el.classList.remove('selected'));
    thumb.classList.add('selected');
    onSelect(imageData);
  });
  gridEl.appendChild(thumb);
  gridEl.querySelectorAll('.frame-thumb.selected').forEach((el) => el.classList.remove('selected'));
  thumb.classList.add('selected');
  onSelect(imageData);
}

// Drives the "live-playing preview + Pause/Play + Capture frame +
// Capture all frames" flow shared by the GIF and WebP animated paths,
// so both look and behave exactly like the SVG tab's live preview
// (same badge/hint copy, same button flow, same green "Capture all
// frames" -> red "Clear captures" toggle).
//
// Unlike SVG (continuous playback with no fixed frame list), GIF/WebP
// already have every frame decoded up front, each with its own
// `delayMs` — so playback here is just stepping through that array on
// a timer, and "Capture all frames" can capture the real full set
// instead of a sampled heuristic.
//
// opts: { canvas, playPauseBtn, captureBtn, clearAllBtn, grid,
//         downloadBtn, frames: [{ imageData, delayMs }], downloadName,
//         onFailure }
// Returns { stop() } — call stop() before loading a new file.
//
// stop() detaches this player completely, and that matters more than it
// sounds. Every call to this function added four more listeners to the same
// four buttons and the old ones were never removed, so after a second file was
// loaded: pressing Pause restarted the *previous* animation, drawing its
// frames onto the same canvas as the current one; every Capture frame click
// added two thumbnails, one of them from the file that was no longer open; and
// the two players fought over the gallery. The listeners hang off an
// AbortController now, and the "capture all" chain -- which used to keep firing
// every 80ms into the new file's gallery -- is cancelled with them.
function createAnimPlayer(opts) {
  const {
    canvas, playPauseBtn, captureBtn, clearAllBtn, grid, downloadBtn,
    frames, downloadName, onFailure,
  } = opts;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const detach = new AbortController();
  const listen = (el, event, fn) => el.addEventListener(event, fn, { signal: detach.signal });

  let index = 0;
  let playing = true;
  let timer = null;
  let captureTimer = null;
  let stopped = false;
  let captureCount = 0;
  let capturingAll = false;
  let selectedCapture = null;

  canvas.width = frames[0].imageData.width;
  canvas.height = frames[0].imageData.height;

  function drawFrame(i) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.putImageData(frames[i].imageData, 0, 0);
  }

  function scheduleNext() {
    clearTimeout(timer);
    if (stopped || !playing || frames.length <= 1) return;
    const delay = Math.max(20, frames[index].delayMs || 100);
    timer = setTimeout(() => {
      index = (index + 1) % frames.length;
      drawFrame(index);
      scheduleNext();
    }, delay);
  }

  drawFrame(index);
  scheduleNext();

  playPauseBtn.textContent = 'Pause';
  listen(playPauseBtn, 'click', () => {
    playing = !playing;
    playPauseBtn.textContent = playing ? 'Pause' : 'Play';
    if (playing) scheduleNext();
    else clearTimeout(timer);
  });

  // Reflects captureCount / capturingAll onto the third anim-control
  // button, identical to the SVG tab: green "Capture all frames" while
  // the gallery is empty, red "Clear captures" once at least one frame
  // exists, disabled + "Capturing…" mid-batch.
  function updateClearAllButton() {
    if (capturingAll) {
      clearAllBtn.disabled = true;
      clearAllBtn.textContent = 'Capturing…';
      clearAllBtn.classList.remove('btn-clear-captures');
      clearAllBtn.classList.add('btn-capture-all');
      return;
    }
    clearAllBtn.disabled = false;
    if (captureCount === 0) {
      clearAllBtn.textContent = 'Capture all frames';
      clearAllBtn.classList.remove('btn-clear-captures');
      clearAllBtn.classList.add('btn-capture-all');
    } else {
      clearAllBtn.textContent = 'Clear captures';
      clearAllBtn.classList.remove('btn-capture-all');
      clearAllBtn.classList.add('btn-clear-captures');
    }
  }

  function captureOne(imageData) {
    captureCount++;
    appendFrameThumbnail(grid, imageData, (data) => {
      selectedCapture = data;
      downloadBtn.hidden = false;
    });
    updateClearAllButton();
  }

  listen(captureBtn, 'click', () => captureOne(frames[index].imageData));

  function clearCaptures() {
    grid.innerHTML = '';
    captureCount = 0;
    selectedCapture = null;
    downloadBtn.hidden = true;
    updateClearAllButton();
  }

  function captureAllFrames() {
    capturingAll = true;
    updateClearAllButton();
    let i = 0;
    const captureNext = () => {
      if (stopped) return;
      if (i >= frames.length) {
        capturingAll = false;
        captureTimer = null;
        updateClearAllButton();
        return;
      }
      captureOne(frames[i].imageData);
      i++;
      captureTimer = setTimeout(captureNext, 80);
    };
    captureNext();
  }

  listen(clearAllBtn, 'click', () => {
    if (capturingAll) return;
    if (captureCount === 0) captureAllFrames();
    else clearCaptures();
  });

  listen(downloadBtn, 'click', () => {
    if (!selectedCapture) return;
    const c = document.createElement('canvas');
    c.width = selectedCapture.width;
    c.height = selectedCapture.height;
    c.getContext('2d').putImageData(selectedCapture, 0, 0);
    triggerPngDownload(c, downloadName, onFailure);
  });

  updateClearAllButton();

  return {
    stop() {
      stopped = true;
      playing = false;
      capturingAll = false;
      clearTimeout(timer);
      clearTimeout(captureTimer);
      detach.abort();
    },
  };
}
