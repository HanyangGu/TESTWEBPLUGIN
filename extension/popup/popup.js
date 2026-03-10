// popup.js — thin UI shell.
// All agent logic runs in background.js.
// This file only: collects inputs, sends START to background, displays live updates.

let fileBase64 = null;
let selectedFile = null;

// ── DOM refs ──────────────────────────────────────────────────
const cfgToggle = document.getElementById('cfgToggle');
const cfgPanel  = document.getElementById('cfgPanel');
const apiKeyEl  = document.getElementById('apiKey');
const saveKeyEl = document.getElementById('saveKey');
const targetUrl = document.getElementById('targetUrl');
const useTabBtn = document.getElementById('useTab');
const dz        = document.getElementById('dz');
const fi        = document.getElementById('fi');
const pill      = document.getElementById('pill');
const fnEl      = document.getElementById('fn');
const fsEl      = document.getElementById('fs');
const rmBtn     = document.getElementById('rm');
const instrEl   = document.getElementById('instr');
const goBtn     = document.getElementById('goBtn');
const stopBtn   = document.getElementById('stopBtn');
const statusBar = document.getElementById('statusBar');
const stepBadge = document.getElementById('stepBadge');
const ssDiv     = document.getElementById('ss');
const ssImg     = document.getElementById('ssImg');
const ssLbl     = document.getElementById('ssLbl');
const logPanel  = document.getElementById('logPanel');

// ── Init: load saved key + tab URL + restore running state ────
document.addEventListener('DOMContentLoaded', async () => {
  const s = await chrome.storage.local.get('openaiKey');
  if (s.openaiKey) apiKeyEl.value = s.openaiKey;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && !tab.url.startsWith('chrome://')) {
    targetUrl.value = tab.url;
    // Auto-detect Canvas and pre-fill instruction
    if (tab.url.includes('instructure.com') || tab.url.includes('canvas.')) {
      const instrEl2 = document.getElementById('instr');
      if (!instrEl2.value) instrEl2.value = 'Submit this PDF as my assignment submission.';
      document.getElementById('canvasBadge').style.display = 'flex';
    }
  }

  // Restore live state if agent is already running (popup was closed & reopened)
  const state = await chrome.runtime.sendMessage({ cmd: 'getState' });
  if (state) {
    restoreState(state);
  }

  updateGoBtn();
});

// ── Listen for live events from background ────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.event === 'log')        addLog(msg.type, msg.msg);
  if (msg.event === 'screenshot') showScreenshot(msg.data, 'AI analyzing…');
  if (msg.event === 'status')     updateRunningUI(msg.running, msg.step, msg.maxSteps);
});

function restoreState(state) {
  // Replay logs
  logPanel.innerHTML = '';
  logPanel.classList.add('show');
  state.logs.forEach(l => addLog(l.type, l.msg, false));

  // Restore screenshot
  if (state.lastScreenshot) showScreenshot(state.lastScreenshot, 'Last captured frame');

  updateRunningUI(state.running, state.step, state.maxSteps);
}

function updateRunningUI(running, step, maxSteps) {
  if (running) {
    statusBar.classList.add('show');
    stepBadge.textContent = `${step}/${maxSteps}`;
    goBtn.style.display = 'none';
    stopBtn.classList.add('show');
  } else {
    statusBar.classList.remove('show');
    goBtn.style.display = '';
    stopBtn.classList.remove('show');
    updateGoBtn();
  }
}

// ── Config ────────────────────────────────────────────────────
cfgToggle.addEventListener('click', () => cfgPanel.classList.toggle('open'));
saveKeyEl.addEventListener('click', async () => {
  const key = apiKeyEl.value.trim();
  if (!key.startsWith('sk-')) { addLog('err', 'Key must start with sk-'); return; }
  await chrome.storage.local.set({ openaiKey: key });
  addLog('ok', 'API key saved');
  cfgPanel.classList.remove('open');
  updateGoBtn();
});

// ── Use active tab URL ─────────────────────────────────────────
useTabBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) { targetUrl.value = tab.url; updateGoBtn(); }
});
targetUrl.addEventListener('input', updateGoBtn);

// ── File handling ──────────────────────────────────────────────
dz.addEventListener('click', () => fi.click());
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', e => {
  e.preventDefault(); dz.classList.remove('over');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fi.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });

rmBtn.addEventListener('click', () => {
  selectedFile = null; fileBase64 = null;
  pill.classList.remove('show'); dz.style.display = 'block'; fi.value = '';
  updateGoBtn();
});

function handleFile(file) {
  if (!file.type.includes('pdf')) { addLog('err', 'Only PDF files supported'); return; }
  selectedFile = file;
  fnEl.textContent = file.name;
  fsEl.textContent = formatBytes(file.size);
  pill.classList.add('show');
  dz.style.display = 'none';
  const reader = new FileReader();
  reader.onload = () => { fileBase64 = reader.result.split(',')[1]; updateGoBtn(); };
  reader.readAsDataURL(file);
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function updateGoBtn() {
  const hasKey = apiKeyEl.value.trim().startsWith('sk-');
  const hasFile = !!fileBase64;
  const hasUrl = targetUrl.value.trim().startsWith('http');
  goBtn.disabled = !(hasKey && hasFile && hasUrl);
}

// ── Start ──────────────────────────────────────────────────────
goBtn.addEventListener('click', async () => {
  const key = apiKeyEl.value.trim();
  if (!key.startsWith('sk-')) { addLog('err', 'Missing API key'); return; }
  if (!fileBase64) { addLog('err', 'No file selected'); return; }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { addLog('err', 'No active tab'); return; }

  // Navigate tab to target URL if different
  const url = targetUrl.value.trim();
  if (tab.url !== url) {
    await chrome.tabs.update(tab.id, { url });
    // Small delay so navigation starts
    await new Promise(r => setTimeout(r, 500));
  }

  logPanel.innerHTML = '';
  logPanel.classList.add('show');

  const resp = await chrome.runtime.sendMessage({
    cmd: 'start',
    tabId: tab.id,
    apiKey: key,
    instruction: instrEl.value.trim() || `Upload the PDF "${selectedFile.name}" to an appropriate place on this site.`,
    fileName: selectedFile.name,
    fileBase64: fileBase64,
  });

  if (!resp?.ok) {
    addLog('err', resp?.err || 'Failed to start agent');
    return;
  }

  updateRunningUI(true, 0, 25);
  addLog('ok', 'Agent started in background — you can close this popup!');
});

// ── Stop ───────────────────────────────────────────────────────
stopBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ cmd: 'stop' });
  updateRunningUI(false, 0, 25);
});

// ── UI helpers ─────────────────────────────────────────────────
function showScreenshot(b64, label) {
  ssImg.src = 'data:image/jpeg;base64,' + b64;
  ssLbl.textContent = label || '';
  ssDiv.classList.add('show');
}

function addLog(type, msg, animate = true) {
  const e = document.createElement('div');
  e.className = 'le';
  if (!animate) e.style.animation = 'none';
  const d = document.createElement('div'); d.className = 'ld ' + type;
  const t = document.createElement('div'); t.className = 'lt';
  t.textContent = msg;
  e.appendChild(d); e.appendChild(t);
  logPanel.appendChild(e);
  logPanel.scrollTop = logPanel.scrollHeight;
}
