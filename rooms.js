const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

function genId() { return crypto.randomBytes(6).toString('hex'); }

function createRoom({ name, type, password, owner }) {
  name = String(name || '').trim();
  if (!name || name.length > 40) throw new Error('Room name required (max 40 chars)');
  type = type === 'closed' ? 'closed' : 'open';
  let password_hash = null;
  if (type === 'closed') {
    if (!password || password.length < 1) throw new Error('Password required for closed rooms');
    password_hash = bcrypt.hashSync(String(password), 10);
  }
  const id = genId();
  const owner_id = owner && owner.id ? owner.id : null;
  const owner_name = owner && owner.username ? owner.username : 'Guest';
  db.prepare('INSERT INTO rooms (id,name,type,password_hash,owner_id,owner_name,max_members,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, name, type, password_hash, owner_id, owner_name, 20, Date.now());
  return getRoom(id, false);
}

function getRoom(id, includeHash = false) {
  const r = db.prepare('SELECT id,name,type,password_hash,owner_id,owner_name,max_members,created_at FROM rooms WHERE id=?').get(id);
  if (!r) return null;
  const out = { id: r.id, name: r.name, type: r.type, owner_id: r.owner_id, owner_name: r.owner_name, max_members: r.max_members, created_at: r.created_at, has_password: !!r.password_hash };
  if (includeHash) out.password_hash = r.password_hash;
  return out;
}

function listRooms() {
  const rows = db.prepare('SELECT id,name,type,owner_name,max_members,created_at FROM rooms ORDER BY created_at DESC').all();
  return rows.map(r => ({ id: r.id, name: r.name, type: r.type, owner_name: r.owner_name, max_members: r.max_members, created_at: r.created_at }));
}

function verifyPassword(room, password) {
  if (room.type !== 'closed') return true;
  const r = db.prepare('SELECT password_hash FROM rooms WHERE id=?').get(room.id);
  if (!r || !r.password_hash) return false;
  return bcrypt.compareSync(String(password || ''), r.password_hash);
}

function deleteRoom(id, userId) {
  const r = db.prepare('SELECT owner_id FROM rooms WHERE id=?').get(id);
  if (!r) throw new Error('Room not found');
  if (r.owner_id !== null && r.owner_id !== userId) throw new Error('Not owner');
  db.prepare('DELETE FROM rooms WHERE id=?').run(id);
  return true;
}

module.exports = { createRoom, getRoom, listRooms, verifyPassword, deleteRoom };