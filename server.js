// dotenv optional; env vars can be set externally
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const auth = require('./auth');
const rooms = require('./rooms');

const PORT = process.env.PORT || 3000;
const app = express();
let io;
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- REST API ----------
app.post('/api/register', (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = auth.register(username, password);
    const token = auth.signToken(user);
    res.json({ ok: true, token, user });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = auth.login(username, password);
    const token = auth.signToken(user);
    res.json({ ok: true, token, user });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get('/api/me', (req, res) => {
  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  const u = auth.verifyToken(tok);
  if (!u) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  res.json({ ok: true, user: u });
});

app.get('/api/rooms', (req, res) => {
  res.json({ ok: true, rooms: rooms.listRooms() });
});

app.post('/api/rooms', (req, res) => {
  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  const u = auth.verifyToken(tok);
  // guests (no token) may also create? Require auth for create; guests can only join open
  if (!u) return res.status(401).json({ ok: false, error: 'Login required to create rooms' });
  try {
    const { name, type, password } = req.body || {};
    const room = rooms.createRoom({ name, type, password, owner: u });
    res.json({ ok: true, room });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/rooms/:id/join', (req, res) => {
  const room = rooms.getRoom(req.params.id);
  if (!room) return res.status(404).json({ ok: false, error: 'Room not found' });
  const { password, guestName } = req.body || {};
  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  const u = auth.verifyToken(tok);
  if (!u && room.type === 'closed') {
    return res.status(403).json({ ok: false, error: 'Guests can only join open rooms' });
  }
  if (room.type === 'closed') {
    if (!rooms.verifyPassword(room, password)) return res.status(403).json({ ok: false, error: 'Wrong password' });
  }
  // determine display name
  let displayName;
  if (u) displayName = u.username;
  else {
    const gn = String(guestName || '').trim();
    if (!/^[a-zA-Z0-9_\- ]{2,24}$/.test(gn)) return res.status(400).json({ ok: false, error: 'Guest name invalid' });
    displayName = gn + ' (guest)';
  }
  res.json({ ok: true, room, displayName, isGuest: !u, userId: u ? u.id : null });
});

app.delete('/api/rooms/:id', (req, res) => {
  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  const u = auth.verifyToken(tok);
  if (!u) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    rooms.deleteRoom(req.params.id, u.id);
    if (io) io.to(req.params.id).emit('room-closed');
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ---------- Socket.io ----------
const server = http.createServer(app);
io = new Server(server, { cors: { origin: '*' } });

// socket data: { user: {id,username} or null, displayName, roomId, isGuest }
const roomMembers = new Map(); // roomId -> Map(socketId -> {displayName, userId, isGuest})
const roomFloor = new Map(); // roomId -> socketId currently talking

function getMembers(roomId) { if (!roomMembers.has(roomId)) roomMembers.set(roomId, new Map()); return roomMembers.get(roomId); }

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, token, guestName }) => {
    const room = rooms.getRoom(roomId);
    if (!room) { socket.emit('error-msg', 'Room not found'); return; }
    let user = null;
    if (token) user = auth.verifyToken(token);
    if (!user && room.type === 'closed') { socket.emit('error-msg', 'Guests can only join open rooms'); return; }
    // closed rooms require password already verified via REST; socket join assumes verified. For safety re-check not possible without password here.
    // Determine display name
    let displayName;
    if (user) displayName = user.username;
    else {
      const gn = String(guestName || '').trim();
      if (!/^[a-zA-Z0-9_\- ]{2,24}$/.test(gn)) { socket.emit('error-msg', 'Invalid guest name'); return; }
      displayName = gn + ' (guest)';
    }
    // capacity check
    const members = getMembers(roomId);
    if (members.size >= (room.max_members || 20)) { socket.emit('error-msg', 'Room full'); return; }

    // leave previous room
    if (socket.data.roomId) leaveRoom(socket);

    socket.data.user = user;
    socket.data.displayName = displayName;
    socket.data.roomId = roomId;
    socket.data.isGuest = !user;

    members.set(socket.id, { displayName, userId: user ? user.id : null, isGuest: !user });
    socket.join(roomId);
    console.log('join-room', socket.id.slice(0,6), displayName, '-> room', roomId, 'members now', members.size);

    // send existing peers to new client
    const peers = [];
    for (const [sid, info] of members) {
      if (sid !== socket.id) peers.push({ id: sid, displayName: info.displayName });
    }
    socket.emit('room-joined', { roomId, room, peers, selfId: socket.id });

    // notify others
    socket.to(roomId).emit('peer-joined', { id: socket.id, displayName });

    // send current floor state
    const floorHolder = roomFloor.get(roomId);
    if (floorHolder && members.has(floorHolder)) {
      const info = members.get(floorHolder);
      socket.emit('ptt:talking', { id: floorHolder, displayName: info.displayName });
    }
  });

  socket.on('offer', ({ to, sdp }) => {
    io.to(to).emit('offer', { from: socket.id, sdp });
  });
  socket.on('answer', ({ to, sdp }) => {
    io.to(to).emit('answer', { from: socket.id, sdp });
  });
  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // Audio streaming (WebSocket relay) for PTT
  socket.on('audio-chunk', ({ roomId, chunk }) => {
    roomId = roomId || socket.data.roomId;
    if (!roomId || socket.data.roomId !== roomId) return;
    const members = getMembers(roomId);
    if (!members.has(socket.id)) return;
    // relay to others
    const ioRoom = io.sockets.adapter.rooms.get(roomId);
    console.log('audio-chunk relay', socket.id.slice(0,6), '-> room', roomId, 'members', members.size, 'ioRoomSize', ioRoom ? ioRoom.size : 0, 'chunk bytes', (chunk && chunk.byteLength) || (chunk && chunk.length) || '?');
    socket.to(roomId).emit('audio-chunk', { from: socket.id, fromName: socket.data.displayName, chunk });
  });

  // PTT floor control
  socket.on('ptt:start', ({ roomId }) => {
    roomId = roomId || socket.data.roomId;
    if (!roomId || socket.data.roomId !== roomId) return;
    const members = getMembers(roomId);
    if (!members.has(socket.id)) return;
    if (roomFloor.has(roomId)) {
      // already someone talking
      socket.emit('ptt:denied', { holder: roomFloor.get(roomId) });
      return;
    }
    roomFloor.set(roomId, socket.id);
    const info = members.get(socket.id);
    io.to(roomId).emit('ptt:talking', { id: socket.id, displayName: info.displayName });
    socket.emit('ptt:granted');
  });

  socket.on('ptt:stop', ({ roomId }) => {
    roomId = roomId || socket.data.roomId;
    if (!roomId) return;
    if (roomFloor.get(roomId) === socket.id) {
      roomFloor.delete(roomId);
      io.to(roomId).emit('ptt:stopped', { id: socket.id });
    }
  });

  socket.on('leave-room', () => leaveRoom(socket));

  socket.on('disconnect', () => leaveRoom(socket));
});

function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const members = getMembers(roomId);
  members.delete(socket.id);
  socket.leave(roomId);
  // release floor if holder left
  if (roomFloor.get(roomId) === socket.id) {
    roomFloor.delete(roomId);
    io.to(roomId).emit('ptt:stopped', { id: socket.id });
  }
  socket.to(roomId).emit('peer-left', { id: socket.id });
  if (members.size === 0) {
    roomMembers.delete(roomId);
    roomFloor.delete(roomId);
  }
  socket.data.roomId = null;
}

server.listen(PORT, () => {
  console.log(`Walkie-Talkie server running on http://localhost:${PORT}`);
});