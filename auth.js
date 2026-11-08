const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'walkie-talkie-dev-secret-change-me';

function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }
function checkPassword(pw, hash) { return bcrypt.compareSync(pw, hash); }

function register(username, password) {
  username = String(username || '').trim();
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) throw new Error('Username must be 3-24 chars, letters/numbers/underscore');
  if (!password || password.length < 4) throw new Error('Password must be at least 4 chars');
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) throw new Error('Username already taken');
  const info = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)')
    .run(username, hashPassword(password), Date.now());
  return { id: info.lastInsertRowid, username };
}

function login(username, password) {
  const u = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
  if (!u) throw new Error('Invalid credentials');
  if (!checkPassword(password, u.password_hash)) throw new Error('Invalid credentials');
  return { id: u.id, username: u.username };
}

function signToken(user) { return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' }); }
function verifyToken(tok) {
  try { return jwt.verify(tok, JWT_SECRET); } catch (e) { return null; }
}

module.exports = { register, login, signToken, verifyToken, hashPassword, checkPassword };