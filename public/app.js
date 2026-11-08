const $ = (s) => document.querySelector(s);

let token = localStorage.getItem('wt_token') || null;
let user = null;
try { user = JSON.parse(localStorage.getItem('wt_user') || 'null'); } catch(e){ user=null; }
let guestName = localStorage.getItem('wt_guest') || null;
let socket = null;
let currentRoomId = null;
let currentRoom = null;
let displayName = null;
let isGuest = false;
let localStream = null;
const peers = new Map(); // peerId -> displayName (presence only)
const receivers = new Map(); // peerId -> MediaSource receiver state
let mediaRecorder = null;
let floorHolder = null;
let iAmTalking = false;
let wantStop = false;

// ---------- views ----------
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  if (name === 'rooms') {
    const createCard = document.querySelector('#view-rooms .card');
    if (createCard) createCard.style.display = isGuestUser() ? 'none' : '';
  }
}
function showTab(name) {
  ['login','register','guest'].forEach(t => {
    document.getElementById('tab-'+t).style.display = (t===name)?'':'none';
  });
}
function updateUserbox() {
  const box = $('#userbox');
  if (token && user) {
    box.innerHTML = `<span>${escapeHtml(user.username)}</span> <button class="btn ghost" onclick="logout()">خروج</button>`;
  } else if (guestName) {
    box.innerHTML = `<span>${escapeHtml(guestName)} (زائر)</span> <button class="btn ghost" onclick="logout()">خروج</button>`;
  } else {
    box.innerHTML = '';
  }
}
function logout() {
  token = null; user = null; guestName = null;
  localStorage.removeItem('wt_token'); localStorage.removeItem('wt_user'); localStorage.removeItem('wt_guest');
  if (socket) { socket.disconnect(); socket = null; }
  stopLocalStream();
  stopRecording();
  updateUserbox();
  showView('auth');
}

// ---------- auth ----------
async function api(path, opts={}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers||{}) } });
  return r.json();
}
async function doLogin() {
  const username = $('#login-user').value.trim();
  const password = $('#login-pass').value;
  const d = await api('/api/login', { method:'POST', body: JSON.stringify({username,password}) });
  if (!d.ok) { $('#login-err').textContent = d.error; return; }
  token = d.token; user = d.user;
  localStorage.setItem('wt_token', token); localStorage.setItem('wt_user', JSON.stringify(user));
  guestName = null; localStorage.removeItem('wt_guest');
  updateUserbox();
  initSocket();
  showView('rooms');
  loadRooms();
}
async function doRegister() {
  const username = $('#reg-user').value.trim();
  const password = $('#reg-pass').value;
  const d = await api('/api/register', { method:'POST', body: JSON.stringify({username,password}) });
  if (!d.ok) { $('#reg-err').textContent = d.error; return; }
  token = d.token; user = d.user;
  localStorage.setItem('wt_token', token); localStorage.setItem('wt_user', JSON.stringify(user));
  guestName = null; localStorage.removeItem('wt_guest');
  updateUserbox();
  initSocket();
  showView('rooms');
  loadRooms();
}
function doGuest() {
  const gn = $('#guest-name').value.trim();
  if (!/^[a-zA-Z0-9_\- ]{2,24}$/.test(gn)) { $('#guest-err').textContent = 'اسم غير صالح'; return; }
  guestName = gn;
  localStorage.setItem('wt_guest', guestName);
  token = null; user = null;
  localStorage.removeItem('wt_token'); localStorage.removeItem('wt_user');
  updateUserbox();
  initSocket();
  showView('rooms');
  loadRooms();
}

// ---------- socket ----------
function initSocket() {
  if (socket) socket.disconnect();
  socket = io();
  socket.on('connect', () => {});
  socket.on('error-msg', (m) => { showRoomErr(m); });
  socket.on('room-joined', ({ roomId, room, peers: peerList, selfId }) => {
    currentRoomId = roomId;
    currentRoom = room;
    $('#room-title').textContent = room.name + (room.type==='closed'?' 🔒':'');
    $('#room-meta').textContent = `المالك: ${room.owner_name} · ${room.type==='open'?'مفتوحة':'مغلقة'} · ${peerList.length+1} متصل`;
    peers.clear();
    peerList.forEach(p => peers.set(p.id, p.displayName));
    renderPeers();
    showView('room');
    ensureMic().then(() => updateMicStatus());
    $('#ptt-btn').disabled = false;
  });
  socket.on('peer-joined', ({ id, displayName: dn }) => {
    peers.set(id, dn);
    renderPeers();
    updateRoomMeta();
  });
  socket.on('peer-left', ({ id }) => {
    peers.delete(id);
    endReceiver(id);
    renderPeers();
    updateRoomMeta();
  });
  socket.on('room-closed', () => { alert('تم إغلاق الغرفة'); leaveRoom(); });

  // Audio streaming
  socket.on('audio-chunk', ({ from, fromName, chunk }) => {
    handleAudioChunk(from, fromName, chunk);
  });

  // PTT
  socket.on('ptt:granted', () => {
    if (wantStop) {
      wantStop = false;
      socket.emit('ptt:stop', { roomId: currentRoomId });
      stopRecording();
      setMicEnabled(false);
      return;
    }
    iAmTalking = true;
    startRecording();
    $('#ptt-btn').classList.add('pressing');
    $('#ptt-status').textContent = '🎙️ أنت تتحدث...';
    $('#ptt-status').classList.add('talking');
  });
  socket.on('ptt:denied', ({ holder }) => {
    stopRecording();
    showRoomErr('القناة مشغولة');
  });
  socket.on('ptt:talking', ({ id, displayName: dn }) => {
    floorHolder = id;
    const isMe = id === socket.id;
    if (!isMe) {
      $('#ptt-btn').disabled = true;
    }
    renderPeers();
    if (!isMe) {
      $('#ptt-status').textContent = `🔊 ${escapeHtml(dn)} يتحدث...`;
      $('#ptt-status').classList.add('talking');
    }
  });
  socket.on('ptt:stopped', ({ id }) => {
    wantStop = false;
    if (floorHolder === id) floorHolder = null;
    if (id === socket.id) {
      iAmTalking = false;
      stopRecording();
      $('#ptt-btn').classList.remove('pressing');
    }
    endReceiver(id);
    $('#ptt-btn').disabled = false;
    $('#ptt-status').textContent = 'اضغط مع الاستمرار للتحدث';
    $('#ptt-status').classList.remove('talking');
    renderPeers();
  });
}

// ---------- mic ----------
async function requestMic() {
  await ensureMic();
  updateMicStatus();
}
async function ensureMic() {
  if (localStream) { updateMicStatus(); return; }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    updateMicStatus();
  } catch (e) {
    showRoomErr('تعذر الوصول للميكروفون: ' + e.message + ' — تحقق من صلاحيات المتصفح');
    updateMicStatus();
  }
}
function updateMicStatus() {
  const el = document.getElementById('mic-status');
  if (!el) return;
  if (localStream) {
    const t = localStream.getAudioTracks()[0];
    el.textContent = '🎤 الميكروفون: مفعل' + (t ? ' (' + t.label + ')' : '');
    el.style.color = '#22c55e';
  } else {
    el.textContent = '🎤 الميكروفون: غير مفعل — اضغط "تفعيل الميكروفون"';
    el.style.color = '#ef4444';
  }
}
function stopLocalStream() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
}

// ---------- recording ----------
function startRecording() {
  if (!localStream) { showRoomErr('لا يوجد ميكروفون'); return; }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') return;
  let mime = '';
  if (typeof MediaRecorder !== 'undefined') {
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus';
    else if (MediaRecorder.isTypeSupported('audio/webm')) mime = 'audio/webm';
  }
  try {
    mediaRecorder = mime ? new MediaRecorder(localStream, { mimeType: mime }) : new MediaRecorder(localStream);
  } catch (e) {
    try { mediaRecorder = new MediaRecorder(localStream); } catch (err) { showRoomErr('MediaRecorder غير مدعوم'); return; }
  }
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0 && currentRoomId && socket) {
      e.data.arrayBuffer().then(buf => {
        socket.emit('audio-chunk', { roomId: currentRoomId, chunk: buf });
      });
    }
  };
  mediaRecorder.onerror = (e) => { console.error('recorder error', e); };
  try { mediaRecorder.start(250); } catch (e) { console.error('start err', e); }
}
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch (e) {}
  }
  mediaRecorder = null;
}

// ---------- audio playback (MediaSource) ----------
function handleAudioChunk(from, fromName, chunk) {
  let r = receivers.get(from);
  if (!r || r.ended) {
    r = { mediaSource: new MediaSource(), sourceBuffer: null, queue: [], audio: null, ended: false };
    receivers.set(from, r);
    r.audio = new Audio();
    r.audio.autoplay = true;
    r.audio.playsInline = true;
    r.audio.volume = 1.0;
    r.audio.muted = false;
    r.audio.src = URL.createObjectURL(r.mediaSource);
    document.body.appendChild(r.audio);
    r.audio.play().catch(e => { console.warn('autoplay blocked', e); });
    r.audio.addEventListener('ended', () => { try { r.audio.remove(); } catch(e){} });
    r.mediaSource.addEventListener('sourceopen', () => {
      try {
        r.sourceBuffer = r.mediaSource.addSourceBuffer('audio/webm;codecs=opus');
      } catch (e) {
        try { r.sourceBuffer = r.mediaSource.addSourceBuffer('audio/webm'); } catch (err) { console.error('addSourceBuffer err', err); }
      }
      if (r.sourceBuffer) {
        r.sourceBuffer.addEventListener('updateend', () => {
          if (r.queue.length && !r.sourceBuffer.updating) {
            const next = r.queue.shift();
            try { r.sourceBuffer.appendBuffer(next); } catch (err) { console.warn('append err', err); }
          }
        });
        // flush queue
        while (r.queue.length && !r.sourceBuffer.updating) {
          const next = r.queue.shift();
          try { r.sourceBuffer.appendBuffer(next); } catch (err) { r.queue.unshift(next); break; }
        }
      }
    });
  }
  const arr = (chunk instanceof ArrayBuffer) ? new Uint8Array(chunk) : new Uint8Array(chunk);
  if (r.sourceBuffer && !r.sourceBuffer.updating) {
    try { r.sourceBuffer.appendBuffer(arr); } catch (e) { r.queue.push(arr); }
  } else {
    r.queue.push(arr);
  }
  // ensure playing
  if (r.audio) r.audio.play().catch(()=>{});
}
function endReceiver(from) {
  const r = receivers.get(from);
  if (r) {
    if (r.mediaSource && r.mediaSource.readyState === 'open') {
      try { r.mediaSource.endOfStream(); } catch (e) {}
    }
    r.ended = true;
  }
}
function enableAudio() {
  receivers.forEach(r => { if (r.audio) { r.audio.muted = false; r.audio.volume = 1.0; r.audio.play().catch(e=>console.warn(e)); } });
}

// ---------- rooms ----------
async function loadRooms() {
  const d = await api('/api/rooms');
  if (!d.ok) return;
  const list = $('#rooms-list');
  list.innerHTML = '';
  if (!d.rooms.length) { list.innerHTML = '<p class="small">لا توجد غRooms. أنشئ واحدة.</p>'.replace('GRooms','غرف'); return; }
  d.rooms.forEach(r => {
    const div = document.createElement('div');
    div.className = 'room-item';
    div.innerHTML = `
      <div>
        <strong>${escapeHtml(r.name)}</strong> ${r.type==='closed'?'<span class="lock">🔒</span>':''}
        <div class="meta">المالك: ${escapeHtml(r.owner_name)} · ${r.type==='open'?'مفتوحة':'مغلقة'}</div>
      </div>
      <button class="btn" onclick="joinRoomPrompt('${r.id}','${r.type}')">انضمام</button>
    `;
    list.appendChild(div);
  });
}
async function createRoom() {
  const name = $('#room-name').value.trim();
  const type = $('#room-type').value;
  const password = $('#room-pass').value;
  const d = await api('/api/rooms', { method:'POST', body: JSON.stringify({ name, type, password }) });
  if (!d.ok) { $('#create-err').textContent = d.error; $('#create-ok').textContent=''; return; }
  $('#create-err').textContent = '';
  $('#create-ok').textContent = 'تم إنشاء الغرفة: ' + d.room.name;
  $('#room-name').value = ''; $('#room-pass').value = '';
  loadRooms();
}
$('#room-type').addEventListener('change', (e) => {
  $('#room-pass').style.display = e.target.value==='closed' ? '' : 'none';
});

let _pwResolve = null;
function requestPassword() {
  return new Promise((resolve) => {
    _pwResolve = resolve;
    $('#pw-input').value = '';
    $('#pw-err').textContent = '';
    $('#pw-modal').style.display = 'flex';
    $('#pw-input').focus();
  });
}
function submitPw() {
  const v = $('#pw-input').value;
  if (_pwResolve) { _pwResolve(v); _pwResolve = null; }
  $('#pw-modal').style.display = 'none';
}
function closePw() {
  if (_pwResolve) { _pwResolve(null); _pwResolve = null; }
  $('#pw-modal').style.display = 'none';
}

async function joinRoomPrompt(roomId, type) {
  let password = '';
  if (type === 'closed') {
    password = await requestPassword();
    if (password === null) return;
  }
  const body = { password };
  if (isGuestUser()) body.guestName = guestName;
  const d = await api('/api/rooms/' + roomId + '/join', { method:'POST', body: JSON.stringify(body) });
  if (!d.ok) { alert(d.error); return; }
  displayName = d.displayName;
  isGuest = d.isGuest;
  await ensureMic();
  socket.emit('join-room', {
    roomId,
    token: token || null,
    guestName: isGuest ? guestName : undefined
  });
}

function isGuestUser() { return !token && !!guestName; }

function leaveRoom() {
  if (socket && currentRoomId) socket.emit('leave-room');
  peers.clear();
  receivers.forEach(r => { if (r.audio) r.audio.remove(); });
  receivers.clear();
  stopRecording();
  stopLocalStream();
  currentRoomId = null; currentRoom = null; floorHolder = null; iAmTalking = false; wantStop = false;
  $('#ptt-btn').disabled = true;
  $('#ptt-btn').classList.remove('pressing');
  showView('rooms');
  loadRooms();
}

// ---------- PTT ----------
const pttBtn = $('#ptt-btn');
function startTalk(e) {
  if (e) e.preventDefault();
  if (!currentRoomId || !socket) return;
  if (floorHolder && floorHolder !== socket.id) return;
  wantStop = false;
  socket.emit('ptt:start', { roomId: currentRoomId });
}
function stopTalk(e) {
  if (e) e.preventDefault();
  if (!currentRoomId || !socket) return;
  wantStop = true;
  if (iAmTalking) {
    iAmTalking = false;
    stopRecording();
    $('#ptt-btn').classList.remove('pressing');
    socket.emit('ptt:stop', { roomId: currentRoomId });
  }
}
pttBtn.addEventListener('mousedown', startTalk);
pttBtn.addEventListener('mouseup', stopTalk);
pttBtn.addEventListener('mouseleave', stopTalk);
pttBtn.addEventListener('touchstart', startTalk, { passive: false });
pttBtn.addEventListener('touchend', stopTalk);
pttBtn.addEventListener('touchcancel', stopTalk);
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && currentRoomId && document.activeElement === document.body) {
    e.preventDefault(); startTalk();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && currentRoomId) { stopTalk(); }
});

// ---------- peers render ----------
function renderPeers() {
  const container = $('#peers');
  container.innerHTML = '';
  const selfDiv = document.createElement('div');
  selfDiv.className = 'peer' + (floorHolder === socket?.id ? ' talking' : '');
  selfDiv.textContent = displayName + ' (أنت)';
  container.appendChild(selfDiv);
  peers.forEach((name, id) => {
    const div = document.createElement('div');
    div.className = 'peer' + (floorHolder === id ? ' talking' : '');
    div.textContent = name;
    container.appendChild(div);
  });
}
function updateRoomMeta() {
  if (!currentRoom) return;
  const count = peers.size + 1;
  $('#room-meta').textContent = `المالك: ${currentRoom.owner_name} · ${currentRoom.type==='open'?'مفتوحة':'مغلقة'} · ${count} متصل`;
}
function showRoomErr(m) { const el = $('#room-err'); if (el) { el.textContent = m; setTimeout(()=>{ if (el.textContent===m) el.textContent=''; }, 4000); } }

function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ---------- init ----------
function checkAuth() {
  if (token) {
    const u = JSON.parse(localStorage.getItem('wt_user')||'null');
    if (u) { user = u; updateUserbox(); initSocket(); showView('rooms'); loadRooms(); return; }
  }
  if (guestName) {
    updateUserbox(); initSocket(); showView('rooms'); loadRooms(); return;
  }
  showView('auth');
}
(async () => {
  if (token) {
    const d = await api('/api/me');
    if (!d.ok) { token = null; user = null; localStorage.removeItem('wt_token'); localStorage.removeItem('wt_user'); }
  }
  checkAuth();
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(()=>{});
}