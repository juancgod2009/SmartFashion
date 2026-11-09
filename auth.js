'use strict';
const crypto = require('node:crypto');
const { db } = require('./db');
const cfg = require('./config');
const { parseCookies, sha256 } = require('./util');

const scrypt = (pw, salt) => new Promise((ok, ko) => crypto.scrypt(pw, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (e, k) => e ? ko(e) : ok(k)));

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(pw, salt)).toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored).split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const k = await scrypt(pw, Buffer.from(s, 'base64'));
  const want = Buffer.from(h, 'base64');
  return k.length === want.length && crypto.timingSafeEqual(k, want);
}
let dummy; // para que el tiempo de respuesta no revele si el correo existe
const dummyHash = async () => dummy ||= await hashPassword(crypto.randomBytes(8).toString('hex'));

function validarPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 12) return 'La contraseña debe tener al menos 12 caracteres.';
  if (pw.length > 200) return 'La contraseña es demasiado larga.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Usa letras y números en la contraseña.';
  return '';
}

const COOKIE = 'sf_admin', HORAS = 8;
function createSession(adminId) {
  const token = crypto.randomBytes(32).toString('base64url'), csrf = crypto.randomBytes(24).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions(id, admin_id, csrf, expires_at) VALUES (?,?,?,?)').run(sha256(token), adminId, csrf, Date.now() + HORAS * 3600_000);
  return { token, csrf };
}
const cookieHeader = token => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${HORAS * 3600}${cfg.prod ? '; Secure' : ''}`;
const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cfg.prod ? '; Secure' : ''}`;

function getSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE]; if (!token) return null;
  const row = db.prepare('SELECT s.id, s.csrf, s.expires_at, a.id AS admin_id, a.email FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.id = ?').get(sha256(token));
  if (!row || row.expires_at < Date.now()) return null;
  return { sid: row.id, csrf: row.csrf, adminId: row.admin_id, email: row.email };
}
const destroySession = sid => db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);

async function crearAdmin(email, password) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Correo no válido.');
  const bad = validarPassword(password); if (bad) throw new Error(bad);
  db.prepare('INSERT INTO admins(email, hash, created_at) VALUES (?,?,?)').run(email, await hashPassword(password), new Date().toISOString());
}

module.exports = { hashPassword, verifyPassword, dummyHash, validarPassword, createSession, cookieHeader, clearCookie, getSession, destroySession, crearAdmin };
