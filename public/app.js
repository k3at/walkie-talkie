const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

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
const peers = new Map(); // peerId -> {pc, pending}
const remoteAudios = new Map();
let floorHolder = null; // socket id of current talker
let iAmTalking = false;

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

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
  socket.on('room-joined', async ({ roomId, room, peers: peerList, selfId }) => {
    currentRoomId = roomId;
    currentRoom = room;
    $('#room-title').textContent = room.name + (room.type==='closed'?' 🔒':'');
    $('#room-meta').textContent = `المالك: ${room.owner_name} · ${room.type==='open'?'مفتوحة':'مغلقة'} · ${peerList.length+1} متصل`;
    // reset peers
    peers.forEach((st, id) => { try { st.pc.close(); } catch(e){} });
    peers.clear();
    remoteAudios.forEach((a) => a.remove());
    remoteAudios.clear();
    // non-initiator: wait for offers from existing
    peerList.forEach(p => createPeer(p.id, false, p.displayName));
    renderPeers();
    showView('room');
    // request mic
    await ensureMic();
    // enable ptt button
    $('#ptt-btn').disabled = false;
  });
  socket.on('peer-joined', ({ id, displayName: dn }) => {
    // we are existing -> initiate offer
    createPeer(id, true, dn);
    renderPeers();
    updateRoomMeta();
  });
  socket.on('room-closed', () => { alert('تم إغلاق الغرفة'); leaveRoom(); });
  socket.on('peer-left', ({ id }) => {
    const st = peers.get(id);
    if (st) { try { st.pc.close(); } catch(e){} peers.delete(id); }
    const a = remoteAudios.get(id);
    if (a) { a.remove(); remoteAudios.delete(id); }
    renderPeers();
    updateRoomMeta();
  });
  socket.on('offer', async ({ from, sdp }) => {
    let st = peers.get(from);
    if (!st) { st = createPeer(from, false, null); }
    const pc = st.pc;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushCandidates(st);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { to: from, sdp: pc.localDescription });
    } catch (e) { console.error('offer err', e); }
  });
  socket.on('answer', async ({ from, sdp }) => {
    const st = peers.get(from);
    if (!st) return;
    try {
      await st.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushCandidates(st);
    } catch (e) { console.error('answer err', e); }
  });
  socket.on('ice-candidate', async ({ from, candidate }) => {
    const st = peers.get(from);
    if (!st) return;
    if (st.pc.remoteDescription) {
      try { await st.pc.addIceCandidate(candidate); } catch(e){}
    } else {
      st.pending.push(candidate);
    }
  });
  socket.on('ptt:granted', () => {
    iAmTalking = true;
    setMicEnabled(true);
    $('#ptt-btn').classList.add('pressing');
    $('#ptt-status').textContent = '🎙️ أنت تتحدث...';
    $('#ptt-status').classList.add('talking');
  });
  socket.on('ptt:denied', ({ holder }) => {
    showRoomErr('القناة مشغولة');
  });
  socket.on('ptt:talking', ({ id, displayName: dn }) => {
    floorHolder = id;
    const isMe = id === socket.id;
    if (!isMe) {
      // disable button
      $('#ptt-btn').disabled = true;
    }
    // highlight peer
    renderPeers();
    if (!isMe) {
      $('#ptt-status').textContent = `🔊 ${escapeHtml(dn)} يتحدث...`;
      $('#ptt-status').classList.add('talking');
    }
  });
  socket.on('ptt:stopped', ({ id }) => {
    if (floorHolder === id) floorHolder = null;
    if (id === socket.id) {
      iAmTalking = false;
      setMicEnabled(false);
      $('#ptt-btn').classList.remove('pressing');
    }
    $('#ptt-btn').disabled = false;
    $('#ptt-status').textContent = 'اضغط مع الاستمرار للتحدث';
    $('#ptt-status').classList.remove('talking');
    renderPeers();
  });
}

function createPeer(peerId, initiator, name) {
  if (peers.has(peerId)) return peers.get(peerId);
  const pc = new RTCPeerConnection(ICE);
  const st = { pc, initiator, pending: [], name };
  peers.set(peerId, st);
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit('ice-candidate', { to: peerId, candidate: e.candidate }); };
  pc.ontrack = (e) => {
    let audio = remoteAudios.get(peerId);
    if (!audio) { audio = document.createElement('audio'); audio.autoplay = true; audio.playsInline = true; document.body.appendChild(audio); remoteAudios.set(peerId, audio); }
    audio.srcObject = e.streams[0];
    audio.play().catch(()=>{});
  };
  if (initiator) {
    pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => {
      socket.emit('offer', { to: peerId, sdp: pc.localDescription });
    }).catch(e => console.error('offer create err', e));
  }
  return st;
}
async function flushCandidates(st) {
  for (const c of st.pending) {
    try { await st.pc.addIceCandidate(c); } catch(e){}
  }
  st.pending = [];
}

async function ensureMic() {
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // mute by default
    localStream.getAudioTracks().forEach(t => { t.enabled = false; });
    // add tracks to existing peers
    peers.forEach(st => {
      localStream.getTracks().forEach(t => st.pc.addTrack(t, localStream));
    });
  } catch (e) {
    showRoomErr('تعذر الوصول للميكروفون: ' + e.message);
    const b = document.getElementById('ptt-btn');
    if (b) b.disabled = true;
  }
}
function setMicEnabled(on) {
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = on; });
}
function stopLocalStream() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
}

// ---------- rooms ----------
async function loadRooms() {
  const d = await api('/api/rooms');
  if (!d.ok) return;
  const list = $('#rooms-list');
  list.innerHTML = '';
  if (!d.rooms.length) { list.innerHTML = '<p class="small">لا توجد غرف. أنشئ واحدة.</p>'; return; }
  d.rooms.forEach(r => {
    const div = document.createElement('div');
    div.className = 'room-item';
    div.innerHTML = `
      <div>
        <strong>${escapeHtml(r.name)}</strong> ${r.type==='closed'?'<span class="lock">🔒</span>':''}
        <div class="meta">المالك: ${escapeHtml(r.owner_name)} · ${r.type==='open'?'مفتوحة':'مغلقة'} · ${new Date(r.created_at).toLocaleString()}</div>
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
  // call join API to validate + get display name
  const body = { password };
  if (isGuestUser()) body.guestName = guestName;
  const d = await api('/api/rooms/' + roomId + '/join', { method:'POST', body: JSON.stringify(body) });
  if (!d.ok) { alert(d.error); return; }
  displayName = d.displayName;
  isGuest = d.isGuest;
  // ensure microphone before joining
  await ensureMic();
  // connect socket join
  socket.emit('join-room', {
    roomId,
    token: token || null,
    guestName: isGuest ? guestName : undefined
  });
}

function isGuestUser() { return !token && !!guestName; }

function leaveRoom() {
  if (socket && currentRoomId) socket.emit('leave-room');
  // cleanup peers
  peers.forEach(st => { try { st.pc.close(); } catch(e){} });
  peers.clear();
  remoteAudios.forEach(a => a.remove());
  remoteAudios.clear();
  stopLocalStream();
  currentRoomId = null; currentRoom = null; floorHolder = null; iAmTalking = false;
  $('#ptt-btn').disabled = true;
  $('#ptt-btn').classList.remove('pressing');
  showView('rooms');
  loadRooms();
}

// ---------- PTT button handlers ----------
const pttBtn = $('#ptt-btn');
function startTalk(e) {
  if (e) e.preventDefault();
  if (!currentRoomId || !socket) return;
  if (floorHolder && floorHolder !== socket.id) return; // someone else talking
  socket.emit('ptt:start', { roomId: currentRoomId });
}
function stopTalk(e) {
  if (e) e.preventDefault();
  if (!currentRoomId || !socket) return;
  if (iAmTalking) socket.emit('ptt:stop', { roomId: currentRoomId });
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
  // self
  const selfDiv = document.createElement('div');
  selfDiv.className = 'peer' + (floorHolder === socket?.id ? ' talking' : '');
  selfDiv.textContent = displayName + ' (أنت)';
  container.appendChild(selfDiv);
  peers.forEach((st, id) => {
    const div = document.createElement('div');
    div.className = 'peer' + (floorHolder === id ? ' talking' : '');
    div.textContent = st.name || id.slice(0,6);
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
// auto join if token valid? verify
(async () => {
  if (token) {
    const d = await api('/api/me');
    if (!d.ok) { token = null; user = null; localStorage.removeItem('wt_token'); localStorage.removeItem('wt_user'); }
  }
  checkAuth();
})();

// register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(()=>{});
}