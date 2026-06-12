// src/renderer/renderer.js
//
// Runs in the browser-like renderer context. Talks to the main process via
// the `grabby` API exposed in preload.js. No Node access here.

const $ = (id) => document.getElementById(id);

const urlInput      = $('url');
const probeBtn      = $('probe-btn');
const resultCard    = $('result');
const alertBox      = $('alert');
const jobsList      = $('jobs-list');
const playlistBanner= $('playlist-banner');
const playlistCount = $('playlist-count');
const dlPlaylistCb  = $('dl-playlist');

let currentInfo = null;
const jobRows = new Map(); // jobId -> { row, title }

// ---------- Utility ----------
function showAlert(msg) {
  alertBox.textContent = msg;
  alertBox.classList.remove('hidden');
}
function hideAlert() { alertBox.classList.add('hidden'); }

function fmtDuration(secs) {
  if (!secs) return '';
  secs = Math.round(secs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
           : `${m}:${String(s).padStart(2,'0')}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

// ---------- Probe ----------
async function probe() {
  const url = urlInput.value.trim();
  if (!url) { showAlert('Paste a URL first.'); return; }
  hideAlert();
  resultCard.classList.add('hidden');
  probeBtn.disabled = true;
  probeBtn.innerHTML = '<span class="spinner"></span>Fetching';

  try {
    const data = await window.grabby.probe(url);
    currentInfo = { ...data, url };
    renderResult(data);
  } catch (e) {
    showAlert(e.message || String(e));
  } finally {
    probeBtn.disabled = false;
    probeBtn.textContent = 'Fetch';
  }
}

function renderResult(data) {
  $('thumb').src = data.thumbnail || '';
  $('thumb').style.visibility = data.thumbnail ? 'visible' : 'hidden';
  $('platform-tag').textContent = (data.platform || 'video').toUpperCase();
  $('vid-title').textContent = data.title || '(untitled)';

  const metaBits = [];
  if (data.uploader) metaBits.push(data.uploader);
  if (data.duration) metaBits.push(fmtDuration(data.duration));
  $('vid-meta').textContent = metaBits.join(' · ');

  if (data.playlistCount && data.playlistCount > 1) {
    playlistCount.textContent = data.playlistCount;
    playlistBanner.classList.remove('hidden');
    dlPlaylistCb.checked = false;
  } else {
    playlistBanner.classList.add('hidden');
  }

  const fl = $('format-list');
  fl.innerHTML = '';
  data.formats.forEach((f, idx) => {
    const lbl = document.createElement('label');
    lbl.innerHTML = `
      <input type="radio" name="fmt" value="${escapeHtml(f.id)}" data-audio="${f.is_audio}" ${idx === 0 ? 'checked' : ''}>
      <span class="fmt-inner">
        <span class="fmt-label">${escapeHtml(f.label)}</span>
        <span class="fmt-sub">${escapeHtml(f.ext || '')}${f.filesize ? ' · ' + escapeHtml(f.filesize) : ''}</span>
      </span>
    `;
    fl.appendChild(lbl);
  });
  resultCard.classList.remove('hidden');
}

// ---------- Download ----------
$('dl-btn').addEventListener('click', async () => {
  const picked = document.querySelector('input[name=fmt]:checked');
  if (!picked || !currentInfo) return;

  const formatId = picked.value;
  const isAudio = picked.dataset.audio === 'true';
  const downloadPlaylist = !playlistBanner.classList.contains('hidden') && dlPlaylistCb.checked;

  const btn = $('dl-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Starting…';

  try {
    const { jobId } = await window.grabby.download({
      url: currentInfo.url,
      formatId,
      isAudio,
      downloadPlaylist,
    });
    addJobRow(jobId, downloadPlaylist
      ? `Playlist: ${currentInfo.title || currentInfo.url}`
      : (currentInfo.title || currentInfo.url));
  } catch (e) {
    showAlert(e.message || String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download';
  }
});

function addJobRow(jobId, title) {
  const row = document.createElement('div');
  row.className = 'job';
  row.dataset.jobId = jobId;
  row.innerHTML = `
    <div>
      <div class="job-title">${escapeHtml(title)}</div>
      <div class="job-status">Queued…</div>
      <div class="progress"><div></div></div>
    </div>
    <div class="job-action">
      <button class="cancel-btn danger" type="button">Cancel</button>
    </div>
  `;
  jobsList.prepend(row);
  row.querySelector('.cancel-btn').addEventListener('click', () => window.grabby.cancel(jobId));
  jobRows.set(jobId, { row, title });
}

// ---------- Real-time job updates ----------
window.grabby.onJobUpdate((update) => {
  const entry = jobRows.get(update.jobId);
  if (!entry) return;
  const { row } = entry;
  const statusEl = row.querySelector('.job-status');
  const bar      = row.querySelector('.progress > div');
  const action   = row.querySelector('.job-action');
  const progBox  = row.querySelector('.progress');

  bar.style.width = (update.progress || 0) + '%';

  if (update.status === 'downloading') {
    const speed = update.speed ? ` · ${(update.speed/1024/1024).toFixed(1)} MB/s` : '';
    const eta = update.eta ? ` · ${update.eta}s left` : '';
    statusEl.className = 'job-status';
    statusEl.textContent = `Downloading ${update.progress || 0}%${speed}${eta}`;
  } else if (update.status === 'processing') {
    statusEl.className = 'job-status';
    statusEl.textContent = 'Processing…';
  } else if (update.status === 'starting') {
    statusEl.className = 'job-status';
    statusEl.textContent = 'Starting…';
  } else if (update.status === 'done') {
    statusEl.className = 'job-status ok';
    const count = update.files.length;
    statusEl.textContent = count > 1 ? `Saved (${count} files)` : 'Saved';
    progBox.style.display = 'none';
    // Replace cancel with open/reveal buttons.
    if (count === 1) {
      const filePath = update.files[0].path;
      action.innerHTML = `
        <button class="open-btn" type="button">Open</button>
        <button class="reveal-btn" type="button">Show</button>
      `;
      action.querySelector('.open-btn').addEventListener('click', () => window.grabby.openFile(filePath));
      action.querySelector('.reveal-btn').addEventListener('click', () => window.grabby.revealFile(filePath));
    } else {
      action.innerHTML = `<button class="reveal-btn" type="button">Show in folder</button>`;
      action.querySelector('.reveal-btn').addEventListener('click', () => window.grabby.openDownloads());
    }
  } else if (update.status === 'error') {
    statusEl.className = 'job-status err';
    statusEl.textContent = 'Error — ' + (update.error || 'unknown');
    progBox.style.display = 'none';
    action.innerHTML = '';
  } else if (update.status === 'cancelled') {
    statusEl.className = 'job-status err';
    statusEl.textContent = 'Cancelled';
    progBox.style.display = 'none';
    action.innerHTML = '';
  }
});

// ---------- Misc ----------
probeBtn.addEventListener('click', probe);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') probe(); });
urlInput.addEventListener('paste', () => {
  setTimeout(() => { if (urlInput.value.trim().startsWith('http')) probe(); }, 50);
});

$('open-folder-btn').addEventListener('click', () => window.grabby.openDownloads());

// ---------- Settings modal ----------
const settingsModal = $('settings-modal');
$('settings-btn').addEventListener('click', async () => {
  const s = await window.grabby.getSettings();
  $('download-dir-display').textContent = s.downloadDir;
  $('cookies-browser').value = s.cookiesBrowser || 'none';
  $('skip-unavailable').checked = !!s.skipUnavailable;
  settingsModal.classList.remove('hidden');
});
$('settings-close').addEventListener('click', () => settingsModal.classList.add('hidden'));
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.classList.add('hidden');
});

$('pick-dir-btn').addEventListener('click', async () => {
  const result = await window.grabby.pickDownloadDir();
  if (result.ok) $('download-dir-display').textContent = result.dir;
});
$('cookies-browser').addEventListener('change', (e) => {
  window.grabby.setSettings({ cookiesBrowser: e.target.value });
});
$('skip-unavailable').addEventListener('change', (e) => {
  window.grabby.setSettings({ skipUnavailable: e.target.checked });
});

// ---------- Version display ----------
window.grabby.appVersion().then(v => {
  $('app-version').textContent = 'v' + v;
});

// ---------- Auto-updater UI ----------
const updateBanner   = $('update-banner');
const updateText     = $('update-text');
const updateActions  = $('update-actions');
const updateDownload = $('update-download-btn');
const updateDismiss  = $('update-dismiss-btn');

let updateState = 'idle';  // 'idle' | 'available' | 'downloading' | 'ready'

function showBanner() { updateBanner.classList.remove('hidden'); }
function hideBanner() { updateBanner.classList.add('hidden'); }

window.grabby.onUpdaterEvent((channel, payload) => {
  switch (channel) {
    case 'update-available':
      updateState = 'available';
      updateText.textContent = `A new version (${payload.version}) is available.`;
      updateActions.innerHTML = `
        <button id="update-download-btn" class="update-btn primary" type="button">Download</button>
        <button id="update-dismiss-btn" class="update-btn ghost" type="button">Later</button>
      `;
      document.getElementById('update-download-btn').addEventListener('click', () => {
        window.grabby.downloadUpdate();
        updateText.textContent = 'Downloading update…';
        updateActions.innerHTML = '';
      });
      document.getElementById('update-dismiss-btn').addEventListener('click', hideBanner);
      showBanner();
      break;

    case 'update-download-progress':
      updateText.textContent = `Downloading update… ${payload.percent}%`;
      break;

    case 'update-downloaded':
      updateState = 'ready';
      updateText.textContent = `Update ${payload.version} ready. Restart to install.`;
      updateActions.innerHTML = `
        <button id="update-install-btn" class="update-btn primary" type="button">Restart now</button>
        <button id="update-later-btn" class="update-btn ghost" type="button">On next quit</button>
      `;
      document.getElementById('update-install-btn').addEventListener('click', () => window.grabby.installUpdate());
      document.getElementById('update-later-btn').addEventListener('click', hideBanner);
      showBanner();
      break;
  }
});
