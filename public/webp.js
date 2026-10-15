// webp.js — WebP -> PNG conversion, entirely client-side.

(function () {
  const canvas = document.getElementById('webp-canvas');
  const ctx = canvas.getContext('2d');
  const preview = document.getElementById('webp-preview');
  const downloadBtn = document.getElementById('webp-download');
  const loadingEl = document.getElementById('webp-loading');
  const fallbackNote = document.getElementById('webp-fallback-note');

  const animSection = document.getElementById('webp-anim-section');
  const animCanvas = document.getElementById('webp-anim-canvas');
  const playPauseBtn = document.getElementById('webp-anim-playpause');
  const captureBtn = document.getElementById('webp-anim-capture');
  const clearAllBtn = document.getElementById('webp-anim-clear');
  const animGrid = document.getElementById('webp-frame-grid');
  const animDownloadBtn = document.getElementById('webp-anim-download');

  let baseName = 'output';
  let currentPlayer = null;

  // Quick byte-level sniff for WebP's ANIM chunk, so we can tell the
  // user "this is animated but this browser can't split its frames"
  // even when the ImageDecoder API isn't available to confirm it directly.
  // The scan itself is in logic.js, where it is tested.
  const hasAnimChunk = (arrayBuffer) => ToPngLogic.containsFourCC(arrayBuffer, 'ANIM', 4096);

  // Decodes every frame via the browser's ImageDecoder API, capturing
  // each frame's own duration (VideoFrame.duration is in microseconds)
  // so the live preview can play back at the WebP's real frame timing,
  // just like GIF's own per-frame delay.
  async function tryDecodeAnimated(arrayBuffer) {
    if (!('ImageDecoder' in window)) return { supported: false };
    try {
      const decoder = new ImageDecoder({ data: arrayBuffer, type: 'image/webp' });
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
      showError('webp-error', 'This browser could not decode the WebP file (or the file is corrupt).');
    };
    img.src = url;
  }

  async function loadFile(file) {
    showError('webp-error', '');
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
    baseName = file.name.replace(/\.webp$/i, '');

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
        onFailure: (why) => showError('webp-error', why),
      });
      scrollToBottom();
      return;
    }

    // The note used to appear only when the ImageDecoder API was missing
    // entirely. The other way to end up here is with the API present and the
    // decode having failed, and that path said nothing at all: an animated
    // file quietly became its first frame with no explanation. What the reader
    // needs to know is the same either way -- this is an animation and only
    // one frame of it could be extracted -- so the note is shown whenever the
    // file is animated and the frames could not be split.
    if (!result.animated && hasAnimChunk(arrayBuffer)) {
      fallbackNote.hidden = false;
    }
    showStaticFrame(file);
  }

  setupDropzone('webp-dropzone', 'webp-input', 'webp-browse', loadFile);
  downloadBtn.addEventListener('click', () =>
    triggerPngDownload(canvas, `${baseName}.png`, (why) => showError('webp-error', why)));
})();
