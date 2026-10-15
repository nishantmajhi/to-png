// avif.js — AVIF -> PNG conversion, entirely client-side.

(function () {
  const canvas = document.getElementById('avif-canvas');
  const ctx = canvas.getContext('2d');
  const preview = document.getElementById('avif-preview');
  const downloadBtn = document.getElementById('avif-download');
  const loadingEl = document.getElementById('avif-loading');
  const fallbackNote = document.getElementById('avif-fallback-note');

  const animSection = document.getElementById('avif-anim-section');
  const animCanvas = document.getElementById('avif-anim-canvas');
  const playPauseBtn = document.getElementById('avif-anim-playpause');
  const captureBtn = document.getElementById('avif-anim-capture');
  const clearAllBtn = document.getElementById('avif-anim-clear');
  const animGrid = document.getElementById('avif-frame-grid');
  const animDownloadBtn = document.getElementById('avif-anim-download');

  let baseName = 'output';
  let currentPlayer = null;

  // Quick byte-level sniff for a 'moov' box, which only appears in
  // AVIF image *sequences* (the animated "avis" brand), not single
  // still images ("mif1"). Used so we can tell the user "this is
  // animated but this browser can't split its frames" even when the
  // ImageDecoder API isn't available to confirm it directly.
  // The scan itself is in logic.js, where it is tested.
  const hasMoovBox = (arrayBuffer) => ToPngLogic.containsFourCC(arrayBuffer, 'moov', 8192);

  // Decodes every frame via the browser's ImageDecoder API, capturing
  // each frame's own duration (VideoFrame.duration is in microseconds)
  // so the live preview can play back at the AVIF's real frame timing —
  // same approach as the WebP tab.
  async function tryDecodeAnimated(arrayBuffer) {
    if (!('ImageDecoder' in window)) return { supported: false };
    try {
      const decoder = new ImageDecoder({ data: arrayBuffer, type: 'image/avif' });
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack;
      if (!track || !track.animated || track.frameCount <= 1) {
        if (decoder.close) decoder.close();
        return { supported: true, animated: false };
      }
      const frameCount = track.frameCount;
      const frames = [];
      let width = 0, height = 0;
      for (let i = 0; i < frameCount; i++) {
        const { image } = await decoder.decode({ frameIndex: i });
        width = image.displayWidth;
        height = image.displayHeight;
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        c.getContext('2d').drawImage(image, 0, 0);
        const imageData = c.getContext('2d').getImageData(0, 0, width, height);
        const delayMs = ToPngLogic.frameDurationToMs(image.duration);
        frames.push({ imageData, delayMs });
        image.close();
      }
      if (decoder.close) decoder.close();
      return { supported: true, animated: true, width, height, frames };
    } catch (err) {
      return { supported: true, animated: false, error: err };
    }
  }

  function showStaticFrame(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      preview.hidden = false;
      downloadBtn.hidden = false;
      scrollToBottom();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      showError('avif-error', 'This browser could not decode the AVIF file (or the file is corrupt).');
    };
    img.src = url;
  }

  async function loadFile(file) {
    showError('avif-error', '');
    if (currentPlayer) {
      currentPlayer.stop();
      currentPlayer = null;
    }
    animGrid.innerHTML = '';
    animSection.hidden = true;
    animDownloadBtn.hidden = true;
    preview.hidden = true;
    downloadBtn.hidden = true;
    fallbackNote.hidden = true;
    baseName = file.name.replace(/\.avif$/i, '');

    const arrayBuffer = await file.arrayBuffer();
    loadingEl.hidden = false;
    const result = await tryDecodeAnimated(arrayBuffer);
    loadingEl.hidden = true;

    if (result.animated && result.frames.length > 1) {
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
        onFailure: (why) => showError('avif-error', why),
      });
      scrollToBottom();
      return;
    }

    // See the same place in webp.js: the note used to appear only when the
    // ImageDecoder API was missing, so a sequence that the API was present for
    // but failed to decode became its first frame with no explanation at all.
    if (!result.animated && hasMoovBox(arrayBuffer)) {
      fallbackNote.hidden = false;
    }
    showStaticFrame(file);
  }

  setupDropzone('avif-dropzone', 'avif-input', 'avif-browse', loadFile);
  downloadBtn.addEventListener('click', () =>
    triggerPngDownload(canvas, `${baseName}.png`, (why) => showError('avif-error', why)));
})();
