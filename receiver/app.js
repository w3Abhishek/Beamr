// State
let isScanning = false;
let currentTransferId = null;
let expectedChunks = 0;
let fileMeta = null;
let receivedChunks = new Map();

// Stats
let lastDecodedTime = 0;
let chunksSinceEstimate = 0;
let startTimeForEstimate = 0;

// DOM Elements
const uiSetup = document.getElementById('ui-setup');
const uiScan = document.getElementById('ui-scan');
const uiDone = document.getElementById('ui-done');

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const viewfinder = document.getElementById('viewfinder');

const startCamBtn = document.getElementById('start-cam-btn');
const camError = document.getElementById('cam-error');

const statusText = document.getElementById('status-text');
const progressBar = document.getElementById('progress-bar');
const chunkCounter = document.getElementById('chunk-counter');
const timeEstimate = document.getElementById('time-estimate');
const logContainer = document.getElementById('log-container');

const doneFilename = document.getElementById('done-filename');
const doneFilesize = document.getElementById('done-filesize');
const downloadBtn = document.getElementById('download-btn');
const resetBtn = document.getElementById('reset-btn');

let finalBlobUrl = null;
let finalFilename = null;

// Audio context for beep (optional feedback, but flash is primary)
let flashTimeout = null;

function flashViewfinder() {
  viewfinder.classList.add('flash');
  if (flashTimeout) clearTimeout(flashTimeout);
  flashTimeout = setTimeout(() => {
    viewfinder.classList.remove('flash');
  }, 100);
}

function appendLog(text) {
  logContainer.textContent = text + ' ' + logContainer.textContent;
  if (logContainer.textContent.length > 50) {
    logContainer.textContent = logContainer.textContent.substring(0, 50);
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function startCamera() {
  camError.classList.add('hidden');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });
    video.srcObject = stream;
    video.setAttribute("playsinline", true); // required to tell iOS safari we don't want fullscreen
    video.play();
    
    requestAnimationFrame(tick);
    
    uiSetup.classList.remove('active');
    uiScan.classList.add('active');
    isScanning = true;
    lastDecodedTime = Date.now();
    
  } catch (err) {
    camError.textContent = `Camera error: ${err.message}. Please ensure permissions are granted and try again.`;
    camError.classList.remove('hidden');
  }
}

startCamBtn.addEventListener('click', startCamera);

function tick() {
  if (!isScanning) return;
  
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    canvas.height = video.videoHeight;
    canvas.width = video.videoWidth;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    // Check if we haven't decoded in a while to show a hint
    const now = Date.now();
    if (currentTransferId && now - lastDecodedTime > 3000) {
      statusText.textContent = "Having trouble locking on — hold steadier, increase brightness, or adjust distance.";
    }

    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "dontInvert",
    });

    if (code) {
      handleCode(code.data);
    }
  }
  
  requestAnimationFrame(tick);
}

function handleCode(data) {
  try {
    const parsed = JSON.parse(data);
    
    if (parsed.t === 'h') {
      // Header frame
      if (parsed.id !== currentTransferId) {
        // New transfer session
        currentTransferId = parsed.id;
        expectedChunks = parsed.n;
        fileMeta = parsed;
        receivedChunks.clear();
        chunksSinceEstimate = 0;
        startTimeForEstimate = Date.now();
        
        statusText.textContent = `Receiving ${parsed.fn} (${formatBytes(parsed.sz)})`;
        statusText.style.color = "var(--accent)";
        appendLog(`[HDR]`);
        flashViewfinder();
        updateProgress();
      }
    } else if (parsed.t === 'd') {
      // Data frame
      if (parsed.id === currentTransferId) {
        if (!receivedChunks.has(parsed.i)) {
          receivedChunks.set(parsed.i, parsed.c);
          chunksSinceEstimate++;
          appendLog(`[${parsed.i}]`);
          flashViewfinder();
          updateProgress();
          
          if (receivedChunks.size === expectedChunks) {
            completeTransfer();
          }
        }
      }
    }
    lastDecodedTime = Date.now();
  } catch (err) {
    // Ignore parse errors, could be incomplete QR or wrong format
  }
}

function updateProgress() {
  if (!expectedChunks) return;
  
  const count = receivedChunks.size;
  chunkCounter.textContent = `Chunks: ${count} / ${expectedChunks}`;
  const pct = (count / expectedChunks) * 100;
  progressBar.style.width = `${pct}%`;
  
  // Update time estimate based on actual chunks/sec
  if (count > 5 && chunksSinceEstimate > 0) {
    const elapsed = Date.now() - startTimeForEstimate;
    const chunksPerMs = chunksSinceEstimate / elapsed;
    const remainingChunks = expectedChunks - count;
    const remainingMs = remainingChunks / chunksPerMs;
    
    if (remainingMs > 0 && isFinite(remainingMs)) {
      timeEstimate.textContent = `Est. remaining: ${(remainingMs / 1000).toFixed(1)}s`;
    }
  }
}

async function sha256HexPrefix(base64String) {
  const binaryString = atob(base64String);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  if (!window.crypto || !window.crypto.subtle) {
    return null; // Fallback for HTTP environments
  }
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex.substring(0, 16);
}

async function completeTransfer() {
  isScanning = false;
  statusText.textContent = "Verifying and decompressing...";
  
  try {
    // 1. Assemble chunks in order
    let assembledBase64 = '';
    for (let i = 0; i < expectedChunks; i++) {
      assembledBase64 += receivedChunks.get(i);
    }
    
    // 2. Verify Hash
    const actualHash = await sha256HexPrefix(assembledBase64);
    if (actualHash !== null && actualHash !== fileMeta.h) {
      throw new Error("Hash mismatch! Data is corrupt.");
    }
    
    // 3. Decode base64 to Uint8Array
    const binaryString = atob(assembledBase64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    // 4. Decompress
    const decompressed = pako.inflate(bytes);
    
    // 5. Create Blob
    const blob = new Blob([decompressed], { type: fileMeta.mt });
    finalBlobUrl = URL.createObjectURL(blob);
    finalFilename = fileMeta.fn;
    
    // Show Done UI
    uiScan.classList.remove('active');
    uiDone.classList.add('active');
    
    doneFilename.textContent = finalFilename;
    doneFilesize.textContent = formatBytes(fileMeta.sz);
    
  } catch (err) {
    alert("Transfer failed: " + err.message);
    resetTransfer(); // Go back to scanning
  }
}

downloadBtn.addEventListener('click', () => {
  if (finalBlobUrl && finalFilename) {
    const a = document.createElement('a');
    a.href = finalBlobUrl;
    a.download = finalFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
});

resetBtn.addEventListener('click', resetTransfer);

function resetTransfer() {
  currentTransferId = null;
  expectedChunks = 0;
  fileMeta = null;
  receivedChunks.clear();
  chunksSinceEstimate = 0;
  logContainer.textContent = '';
  statusText.textContent = 'Waiting for header frame...';
  statusText.style.color = "var(--text-main)";
  progressBar.style.width = '0%';
  chunkCounter.textContent = 'Chunks: 0 / --';
  timeEstimate.textContent = 'Est. remaining: --';
  
  if (finalBlobUrl) {
    URL.revokeObjectURL(finalBlobUrl);
    finalBlobUrl = null;
  }
  finalFilename = null;
  
  uiDone.classList.remove('active');
  uiScan.classList.add('active');
  isScanning = true;
  lastDecodedTime = Date.now();
  requestAnimationFrame(tick);
}

// --- Sending Logic ---

const sendFileBtn = document.getElementById('send-file-btn');
const fileInput = document.getElementById('file-input');
const uiSend = document.getElementById('ui-send');
const sendFilename = document.getElementById('send-filename');
const sendFilesize = document.getElementById('send-filesize');
const sendQrCanvas = document.getElementById('qr-canvas');
const toggleSendBtn = document.getElementById('toggle-send-btn');
const cancelSendBtn = document.getElementById('cancel-send-btn');
const sendFrameCounter = document.getElementById('frame-counter');
const sendLoopCounter = document.getElementById('loop-counter');
const sendTimeEstimate = document.getElementById('send-time-estimate');
const sendProgressBar = document.getElementById('send-progress-bar');
const sendIntervalSlider = document.getElementById('interval-slider');
const sendIntervalVal = document.getElementById('interval-val');

let sendCurrentFile = null;
let sendIsRunning = false;
let sendTimerId = null;
let sendChunkList = [];
let sendHeaderFrame = null;
let sendCurrentFrameIndex = -1;
let sendCurrentLoop = 0;
let sendQrVersion = 4;
let sendJustShowedHeader = false;

if (sendFileBtn && fileInput) {
  sendFileBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', async (e) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      uiSetup.classList.remove('active');
      uiSend.classList.add('active');
      
      sendFilename.textContent = file.name;
      sendFilesize.textContent = formatBytes(file.size);
      
      sendCurrentFile = file;
      await prepareSendPayload();
    }
  });
}

function updateSendTimeEstimate() {
  if (!sendCurrentFile || sendChunkList.length === 0) return;
  const interval = parseInt(sendIntervalSlider.value, 10);
  const totalFrames = sendChunkList.length + Math.ceil(sendChunkList.length / 8) + 1;
  const ms = totalFrames * interval;
  sendTimeEstimate.textContent = `Est. cycle: ${(ms / 1000).toFixed(1)}s`;
}

if (sendIntervalSlider) {
  sendIntervalSlider.addEventListener('input', () => {
    sendIntervalVal.textContent = sendIntervalSlider.value;
    updateSendTimeEstimate();
    if (sendIsRunning) {
      stopSendTransfer();
      startSendTransfer();
    }
  });
}

if (toggleSendBtn) {
  toggleSendBtn.addEventListener('click', () => {
    if (sendIsRunning) {
      stopSendTransfer();
    } else {
      startSendTransfer();
    }
  });
}

if (cancelSendBtn) {
  cancelSendBtn.addEventListener('click', () => {
    stopSendTransfer();
    sendCurrentFile = null;
    sendChunkList = [];
    fileInput.value = '';
    uiSend.classList.remove('active');
    uiSetup.classList.add('active');
  });
}

async function prepareSendPayload() {
  if (!sendCurrentFile) return;
  
  const chunkSize = 700; // Fixed chunk size for web sender
  
  // Read file as ArrayBuffer
  const buffer = await sendCurrentFile.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  
  // Compress
  const compressed = pako.gzip(bytes);
  
  // Convert compressed Uint8Array to base64
  let binaryCompString = '';
  const chunkSizeForString = 0x8000;
  for (let i = 0; i < compressed.length; i += chunkSizeForString) {
    binaryCompString += String.fromCharCode.apply(null, compressed.subarray(i, i + chunkSizeForString));
  }
  const compressedBase64 = btoa(binaryCompString);
  
  // Hash
  const hash = await sha256HexPrefix(compressedBase64);
  
  // Chunking
  sendChunkList = [];
  for (let i = 0; i < compressedBase64.length; i += chunkSize) {
    sendChunkList.push(compressedBase64.substring(i, i + chunkSize));
  }
  
  // Header frame
  const transferId = Math.random().toString(36).substring(2, 8);
  sendHeaderFrame = JSON.stringify({
    t: 'h',
    id: transferId,
    fn: sendCurrentFile.name,
    mt: sendCurrentFile.type || 'application/octet-stream',
    sz: sendCurrentFile.size,
    n: sendChunkList.length,
    h: hash || '0000000000000000'
  });
  
  let maxPayload = sendHeaderFrame;
  if (sendChunkList.length > 0) {
    const dataFrame = JSON.stringify({
      t: 'd',
      id: transferId,
      i: sendChunkList.length - 1,
      c: sendChunkList[0]
    });
    if (dataFrame.length > maxPayload.length) {
      maxPayload = dataFrame;
    }
  }
  
  const qrData = QRCode.create(maxPayload, { errorCorrectionLevel: 'L' });
  sendQrVersion = qrData.version;
  
  updateSendTimeEstimate();
  renderSendQR(sendHeaderFrame);
  sendFrameCounter.textContent = `Ready: ${sendChunkList.length} chunks`;
  sendLoopCounter.textContent = '';
  sendProgressBar.style.width = '0%';
}

function renderSendQR(text) {
  QRCode.toCanvas(sendQrCanvas, text, {
    version: sendQrVersion,
    errorCorrectionLevel: 'L',
    margin: 2,
    scale: 6,
    color: {
      dark: '#000000',
      light: '#ffffff'
    }
  }, function (err) {
    if (err) console.error(err);
  });
}

function startSendTransfer() {
  if (!sendCurrentFile || sendChunkList.length === 0) return;
  sendIsRunning = true;
  toggleSendBtn.textContent = 'Stop Transfer';
  toggleSendBtn.className = 'btn danger';
  sendQrCanvas.parentElement.classList.add('running');
  
  sendCurrentFrameIndex = -1;
  sendCurrentLoop = 1;
  sendJustShowedHeader = false;
  
  sendLoopStep();
}

function stopSendTransfer() {
  sendIsRunning = false;
  toggleSendBtn.textContent = 'Start Transfer';
  toggleSendBtn.className = 'btn primary';
  if (sendQrCanvas && sendQrCanvas.parentElement) {
    sendQrCanvas.parentElement.classList.remove('running');
  }
  clearTimeout(sendTimerId);
}

function sendLoopStep() {
  if (!sendIsRunning) return;
  
  if (sendCurrentFrameIndex === -1) {
    renderSendQR(sendHeaderFrame);
    sendCurrentFrameIndex = 0;
  } else if (sendCurrentFrameIndex > 0 && sendCurrentFrameIndex % 8 === 0 && !sendJustShowedHeader) {
    renderSendQR(sendHeaderFrame);
    sendJustShowedHeader = true;
  } else {
    sendJustShowedHeader = false;
    const payload = JSON.stringify({
      t: 'd',
      id: JSON.parse(sendHeaderFrame).id,
      i: sendCurrentFrameIndex,
      c: sendChunkList[sendCurrentFrameIndex]
    });
    renderSendQR(payload);
    
    sendFrameCounter.textContent = `Frame ${sendCurrentFrameIndex + 1} / ${sendChunkList.length}`;
    sendLoopCounter.textContent = `Loop ${sendCurrentLoop}`;
    
    const pct = ((sendCurrentFrameIndex + 1) / sendChunkList.length) * 100;
    sendProgressBar.style.width = `${pct}%`;
    
    sendCurrentFrameIndex++;
    if (sendCurrentFrameIndex >= sendChunkList.length) {
      sendCurrentFrameIndex = -1;
      sendCurrentLoop++;
    }
  }
  
  const interval = parseInt(sendIntervalSlider.value, 10);
  sendTimerId = setTimeout(sendLoopStep, interval);
}
