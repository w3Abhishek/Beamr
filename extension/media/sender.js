const vscode = acquireVsCodeApi();

let currentFile = null;
let isRunning = false;
let timerId = null;

let chunkList = [];
let headerFrame = null;

let currentFrameIndex = -1;
let currentLoop = 0;
let qrVersion = 4; // default minimum
let justShowedHeader = false;

// Crypto logic to generate SHA-256 hash prefix
async function sha256HexPrefix(base64String) {
  const binaryString = atob(base64String);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex.substring(0, 16);
}

// Format bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// DOM Elements
const uiIdle = document.getElementById('ui-idle');
const uiActive = document.getElementById('ui-active');
const filenameEl = document.getElementById('filename');
const filesizeEl = document.getElementById('filesize');
const intervalSlider = document.getElementById('interval-slider');
const intervalVal = document.getElementById('interval-val');
const chunkSlider = document.getElementById('chunk-slider');
const chunkVal = document.getElementById('chunk-val');
const toggleBtn = document.getElementById('toggle-btn');
const qrCanvas = document.getElementById('qr-canvas');
const qrContainer = document.querySelector('.qr-container');
const frameCounter = document.getElementById('frame-counter');
const loopCounter = document.getElementById('loop-counter');
const timeEstimate = document.getElementById('time-estimate');
const progressBar = document.getElementById('progress-bar');

function updateTimeEstimate() {
  if (!currentFile || chunkList.length === 0) return;
  const interval = parseInt(intervalSlider.value, 10);
  // Total frames in a loop = header + chunks + maybe header every 8 chunks
  const totalFrames = chunkList.length + Math.ceil(chunkList.length / 8) + 1;
  const ms = totalFrames * interval;
  timeEstimate.textContent = `Est. cycle: ${(ms / 1000).toFixed(1)}s`;
}

intervalSlider.addEventListener('input', () => {
  intervalVal.textContent = intervalSlider.value;
  updateTimeEstimate();
  if (isRunning) {
    stopTransfer();
    startTransfer();
  }
});

chunkSlider.addEventListener('input', () => {
  chunkVal.textContent = chunkSlider.value;
  if (!isRunning && currentFile) {
    preparePayload();
  }
});

toggleBtn.addEventListener('click', () => {
  if (isRunning) {
    stopTransfer();
  } else {
    startTransfer();
  }
});

window.addEventListener('message', async event => {
  const message = event.data;
  if (message.type === 'fileData') {
    currentFile = message;
    
    uiIdle.classList.remove('active');
    uiActive.classList.add('active');
    
    filenameEl.textContent = message.filename;
    filesizeEl.textContent = formatBytes(message.size);
    
    stopTransfer();
    await preparePayload();
  }
});

async function preparePayload() {
  if (!currentFile) return;

  const chunkSize = parseInt(chunkSlider.value, 10);
  
  // 1. Decode base64 to Uint8Array
  const binaryString = atob(currentFile.data);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // 2. Compress with pako
  const compressed = pako.gzip(bytes);

  // 3. Base64 encode compressed buffer
  let binaryCompString = '';
  // Avoid Maximum call stack size exceeded for very large arrays
  for (let i = 0; i < compressed.byteLength; i++) {
    binaryCompString += String.fromCharCode(compressed[i]);
  }
  const compressedBase64 = btoa(binaryCompString);

  // 4. Hash the compressed base64
  const hash = await sha256HexPrefix(compressedBase64);

  // 5. Chunk the base64
  chunkList = [];
  for (let i = 0; i < compressedBase64.length; i += chunkSize) {
    chunkList.push(compressedBase64.substring(i, i + chunkSize));
  }

  // 6. Create Header
  const transferId = Math.random().toString(36).substring(2, 8);
  headerFrame = JSON.stringify({
    t: 'h',
    id: transferId,
    fn: currentFile.filename,
    mt: currentFile.mimeType,
    sz: currentFile.size,
    n: chunkList.length,
    h: hash
  });

  // Calculate the maximum QR version needed for any frame so the size never jumps
  let maxPayload = headerFrame;
  if (chunkList.length > 0) {
    const dataFrame = JSON.stringify({
      t: 'd',
      id: transferId,
      i: chunkList.length - 1,
      c: chunkList[0] // The first chunk is always the maximum size
    });
    if (dataFrame.length > maxPayload.length) {
      maxPayload = dataFrame;
    }
  }
  
  // Use QRCode.create to determine the required version
  const qrData = QRCode.create(maxPayload, { errorCorrectionLevel: 'L' });
  qrVersion = qrData.version;

  updateTimeEstimate();
  renderQR(headerFrame);
  frameCounter.textContent = `Ready: ${chunkList.length} chunks`;
  loopCounter.textContent = '';
  progressBar.style.width = '0%';
}

function renderQR(text) {
  // We use qrcode library
  QRCode.toCanvas(qrCanvas, text, {
    version: qrVersion,
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

function startTransfer() {
  if (!currentFile || chunkList.length === 0) return;
  isRunning = true;
  toggleBtn.textContent = 'Stop Transfer';
  toggleBtn.className = 'btn danger';
  qrContainer.classList.add('running');
  
  currentFrameIndex = -1; // -1 means header
  currentLoop = 1;
  justShowedHeader = false;
  
  loopStep();
}

function stopTransfer() {
  isRunning = false;
  toggleBtn.textContent = 'Start Transfer';
  toggleBtn.className = 'btn primary';
  qrContainer.classList.remove('running');
  clearTimeout(timerId);
}

function loopStep() {
  if (!isRunning) return;

  // Header re-send logic: initially, and every ~8 chunks
  if (currentFrameIndex === -1) {
    renderQR(headerFrame);
    currentFrameIndex = 0; // Move to chunk 0 next
  } else if (currentFrameIndex > 0 && currentFrameIndex % 8 === 0 && !justShowedHeader) {
    renderQR(headerFrame);
    justShowedHeader = true;
  } else {
    justShowedHeader = false;
    // Data frame
    const payload = JSON.stringify({
      t: 'd',
      id: JSON.parse(headerFrame).id,
      i: currentFrameIndex,
      c: chunkList[currentFrameIndex]
    });
    renderQR(payload);
    
    // Update UI
    frameCounter.textContent = `Frame ${currentFrameIndex + 1} / ${chunkList.length}`;
    loopCounter.textContent = `Loop ${currentLoop}`;
    
    const pct = ((currentFrameIndex + 1) / chunkList.length) * 100;
    progressBar.style.width = `${pct}%`;

    currentFrameIndex++;
    if (currentFrameIndex >= chunkList.length) {
      currentFrameIndex = -1; // Next is header
      currentLoop++;
    }
  }

  const interval = parseInt(intervalSlider.value, 10);
  timerId = setTimeout(loopStep, interval);
}

// Notify extension that webview is ready to receive messages
vscode.postMessage({ type: 'ready' });
