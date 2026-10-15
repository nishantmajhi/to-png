// gif.js — GIF frame -> PNG conversion, entirely client-side.

(function () {
  const loadingEl = document.getElementById('gif-loading');
  const canvas = document.getElementById('gif-canvas');
  const ctx = canvas.getContext('2d');
  const preview = document.getElementById('gif-preview');
  const downloadBtn = document.getElementById('gif-download');

  const animSection = document.getElementById('gif-anim-section');
  const animCanvas = document.getElementById('gif-anim-canvas');
  const playPauseBtn = document.getElementById('gif-anim-playpause');
  const captureBtn = document.getElementById('gif-anim-capture');
  const clearAllBtn = document.getElementById('gif-anim-clear');
  const animGrid = document.getElementById('gif-frame-grid');
  const animDownloadBtn = document.getElementById('gif-anim-download');

  let baseName = 'output';
  let currentPlayer = null;

  function loadFile(file) {
    showError('gif-error', '');
    if (currentPlayer) {
      currentPlayer.stop();
      currentPlayer = null;
    }
    animGrid.innerHTML = '';
    animSection.hidden = true;
    animDownloadBtn.hidden = true;
    preview.hidden = true;
    downloadBtn.hidden = true;
    loadingEl.hidden = false;
    baseName = file.name.replace(/\.gif$/i, '');

    const reader = new FileReader();
    reader.onload = () => {
      // Decode off the main render path via a microtask so the
      // "Decoding frames…" message actually paints first.
      setTimeout(() => {
        try {
          const result = GifDecoder.decode(reader.result);
          loadingEl.hidden = true;

          if (result.frames.length > 1) {
            // Animated: live-playing preview + capture flow.
            animSection.hidden = false;
            currentPlayer = createAnimPlayer({
              canvas: animCanvas,
              playPauseBtn,
              captureBtn,
              clearAllBtn,
              grid: animGrid,
              downloadBtn: animDownloadBtn,
              frames: result.frames,
              downloadName: `${baseName}-frame.png`,
              onFailure: (why) => showError('gif-error', why),
            });
          } else {
            // Single-frame GIF: static path, converts and downloads in one click.
            const frame = result.frames[0];
            canvas.width = frame.imageData.width;
            canvas.height = frame.imageData.height;
            ctx.putImageData(frame.imageData, 0, 0);
            preview.hidden = false;
            downloadBtn.hidden = false;
          }
          scrollToBottom();
        } catch (err) {
          loadingEl.hidden = true;
          showError('gif-error', 'Could not decode this GIF: ' + err.message);
        }
      }, 10);
    };
    reader.onerror = () => {
      loadingEl.hidden = true;
      showError('gif-error', 'Could not read the file.');
    };
    reader.readAsArrayBuffer(file);
  }

  setupDropzone('gif-dropzone', 'gif-input', 'gif-browse', loadFile);
  downloadBtn.addEventListener('click', () =>
    triggerPngDownload(canvas, `${baseName}.png`, (why) => showError('gif-error', why)));
})();
