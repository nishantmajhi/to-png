// svg.js — SVG -> PNG conversion, entirely client-side.
//
// svgLooksAnimated, svgIntrinsicSize and svgOutputSize live in logic.js, which
// has no DOM in it and is therefore the part that can be tested directly.

// "Capture all frames" grabs this many frames, spaced this far apart,
// so the gallery fills with a spread of moments instead of the user
// having to click "Capture frame" repeatedly by hand.
const CAPTURE_ALL_COUNT = 10;
const CAPTURE_ALL_INTERVAL_MS = 150;

(function () {
  const canvas = document.getElementById('svg-canvas');
  const ctx = canvas.getContext('2d');
  const preview = document.getElementById('svg-preview');
  const controls = document.getElementById('svg-controls');
  const downloadBtn = document.getElementById('svg-download');
  const widthInput = document.getElementById('svg-width');
  const heightInput = document.getElementById('svg-height');
  const scaleSelect = document.getElementById('svg-scale');
  const transparentCheck = document.getElementById('svg-transparent');

  const animSection = document.getElementById('svg-anim-section');
  const animCanvas = document.getElementById('svg-anim-canvas');
  const animCtx = animCanvas.getContext('2d', { willReadFrequently: true });
  const playPauseBtn = document.getElementById('svg-anim-playpause');
  const captureBtn = document.getElementById('svg-anim-capture');
  const clearAllBtn = document.getElementById('svg-anim-clear');
  const animGrid = document.getElementById('svg-frame-grid');
  const animDownloadBtn = document.getElementById('svg-anim-download');

  let svgText = '';
  let baseWidth = 300;
  let baseHeight = 150;
  let fileBaseName = 'output';
  let isAnimated = false;

  let liveImg = null;      // offscreen <img> actually playing the animation
  let rafId = null;
  let playing = true;
  let selectedCapture = null;
  let captureCount = 0;
  let capturingAll = false;

  function parseIntrinsicSize(text) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'image/svg+xml');
    const svgEl = doc.documentElement;
    return ToPngLogic.svgIntrinsicSize(
      svgEl.getAttribute('width'),
      svgEl.getAttribute('height'),
      svgEl.getAttribute('viewBox'),
    );
  }

  function outputSize() {
    return ToPngLogic.svgOutputSize({
      scale: scaleSelect.value,
      width: widthInput.value,
      height: heightInput.value,
      baseWidth,
      baseHeight,
    });
  }

  // ---- Static (non-animated) path ----
  //
  // Returns a promise that settles once the drawing has actually landed on the
  // canvas, and that is the whole of the fix for the worst defect in this
  // project.
  //
  // Rendering is asynchronous: the SVG goes through a blob URL into an <img>
  // and is drawn only in its load handler. But `canvas.width = w` at the top
  // is synchronous, and assigning to a canvas's width resets its bitmap to
  // transparent black — even when the value assigned is the one already there.
  // The download button called renderStatic() and then, on the very next line,
  // triggerPngDownload(), which snapshots the canvas immediately. So it always
  // snapshotted a canvas that had just been cleared and not yet redrawn.
  //
  // Measured in a real Chrome against the original: 1,061,424 opaque pixels on
  // the canvas before the click, 0 at the instant toBlob ran, and 1,061,424
  // again a second and a half later. Every static SVG download this tool has
  // ever produced was a fully transparent PNG.
  function renderStatic(scrollAfter) {
    return new Promise((resolve) => {
      showError('svg-error', '');
      const { w, h } = outputSize();
      canvas.width = w;
      canvas.height = h;

      const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!transparentCheck.checked) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        preview.hidden = false;
        if (scrollAfter) scrollToBottom();
        resolve(true);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        showError('svg-error', 'Could not render this SVG. It may reference external resources the browser blocks, or contain invalid markup.');
        resolve(false);
      };
      img.src = url;
    });
  }

  // ---- Animated path ----
  function stopLiveLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (liveImg) {
      URL.revokeObjectURL(liveImg.src);
      liveImg.remove();
      liveImg = null;
    }
  }

  function startLiveLoop() {
    stopLiveLoop();
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    liveImg = new Image();
    // Must actually be rendered by the browser for SMIL/CSS animation to
    // run. It's kept invisible via opacity + a 1x1 size rather than
    // pushed far off-screen — Chromium throttles (and can fully pause)
    // animations on elements positioned way outside the viewport, which
    // silently froze this on the first frame. drawImage() below still
    // reads the image's full intrinsic size regardless of this tiny
    // on-screen footprint, so output quality is unaffected.
    liveImg.style.position = 'fixed';
    liveImg.style.left = '0';
    liveImg.style.top = '0';
    liveImg.style.width = '1px';
    liveImg.style.height = '1px';
    liveImg.style.opacity = '0';
    liveImg.style.pointerEvents = 'none';
    liveImg.src = url;
    document.body.appendChild(liveImg);

    playing = true;
    playPauseBtn.textContent = 'Pause';

    const tick = () => {
      const { w, h } = outputSize();
      if (animCanvas.width !== w) animCanvas.width = w;
      if (animCanvas.height !== h) animCanvas.height = h;
      if (playing) {
        animCtx.clearRect(0, 0, animCanvas.width, animCanvas.height);
        if (!transparentCheck.checked) {
          animCtx.fillStyle = '#ffffff';
          animCtx.fillRect(0, 0, animCanvas.width, animCanvas.height);
        }
        try {
          animCtx.drawImage(liveImg, 0, 0, animCanvas.width, animCanvas.height);
        } catch (e) {
          // Image not ready yet on the very first tick — ignore, next tick will succeed.
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  playPauseBtn.addEventListener('click', () => {
    playing = !playing;
    playPauseBtn.textContent = playing ? 'Pause' : 'Play';
  });

  // Reflects captureCount / capturingAll onto the third anim-control
  // button: green "Capture all frames" while the gallery is empty,
  // red "Clear captures" once at least one frame exists.
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

  function clearCaptures() {
    animGrid.innerHTML = '';
    captureCount = 0;
    selectedCapture = null;
    animDownloadBtn.hidden = true;
    updateClearAllButton();
  }

  function captureAllFrames() {
    capturingAll = true;
    updateClearAllButton();
    let i = 0;
    const captureNext = () => {
      if (i >= CAPTURE_ALL_COUNT) {
        capturingAll = false;
        updateClearAllButton();
        return;
      }
      const frameData = animCtx.getImageData(0, 0, animCanvas.width, animCanvas.height);
      captureCount++;
      appendFrameThumbnail(animGrid, frameData, (data) => {
        selectedCapture = data;
        animDownloadBtn.hidden = false;
      });
      i++;
      setTimeout(captureNext, CAPTURE_ALL_INTERVAL_MS);
    };
    captureNext();
  }

  captureBtn.addEventListener('click', () => {
    const frameData = animCtx.getImageData(0, 0, animCanvas.width, animCanvas.height);
    captureCount++;
    appendFrameThumbnail(animGrid, frameData, (data) => {
      selectedCapture = data;
      animDownloadBtn.hidden = false;
    });
    updateClearAllButton();
  });

  clearAllBtn.addEventListener('click', () => {
    if (capturingAll) return;
    if (captureCount === 0) {
      captureAllFrames();
    } else {
      clearCaptures();
    }
  });

  animDownloadBtn.addEventListener('click', () => {
    if (!selectedCapture) return;
    const c = document.createElement('canvas');
    c.width = selectedCapture.width;
    c.height = selectedCapture.height;
    c.getContext('2d').putImageData(selectedCapture, 0, 0);
    triggerPngDownload(c, `${fileBaseName}-frame.png`, (why) => showError('svg-error', why));
  });

  function loadFile(file) {
    stopLiveLoop();
    animGrid.innerHTML = '';
    captureCount = 0;
    capturingAll = false;
    selectedCapture = null;
    animDownloadBtn.hidden = true;
    preview.hidden = true;
    downloadBtn.hidden = true;
    updateClearAllButton();

    fileBaseName = file.name.replace(/\.svg$/i, '');
    const reader = new FileReader();
    reader.onload = () => {
      svgText = reader.result;
      const size = parseIntrinsicSize(svgText);
      baseWidth = size.w;
      baseHeight = size.h;
      widthInput.value = Math.round(size.w);
      heightInput.value = Math.round(size.h);
      controls.hidden = false;

      isAnimated = ToPngLogic.svgLooksAnimated(svgText);
      if (isAnimated) {
        animSection.hidden = false;
        startLiveLoop();
        scrollToBottom();
      } else {
        animSection.hidden = true;
        renderStatic(true);
        downloadBtn.hidden = false;
      }
    };
    reader.onerror = () => showError('svg-error', 'Could not read the file.');
    reader.readAsText(file);
  }

  setupDropzone('svg-dropzone', 'svg-input', 'svg-browse', loadFile);

  downloadBtn.addEventListener('click', () => {
    renderStatic().then((drawn) => {
      if (!drawn) return;
      triggerPngDownload(canvas, `${fileBaseName}.png`, (why) => showError('svg-error', why));
    });
  });

  [scaleSelect, widthInput, heightInput, transparentCheck].forEach((el) =>
    el.addEventListener('change', () => {
      if (!svgText) return;
      if (isAnimated) {
        // live loop already reads outputSize() every tick; nothing else to do
      } else {
        renderStatic();
      }
    })
  );
})();
