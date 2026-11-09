'use strict';
const crypto = require('node:crypto');
const cfg = require('./config');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

function json(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    if ((Number(req.headers['content-length']) || 0) > limit) { req.resume(); return reject(new HttpError(413, 'El contenido enviado es demasiado grande.')); }
    const chunks = []; let size = 0, over = false;
    req.on('data', c => { size += c.length; if (size > limit) over = true; else chunks.push(c); });
    req.on('end', () => over ? reject(new HttpError(413, 'El contenido enviado es demasiado grande.')) : resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  try { const v = JSON.parse(buf.toString('utf8') || '{}'); if (v === null || typeof v !== 'object') throw 0; return v; }
  catch { throw new HttpError(400, 'La solicitud no tiene un formato válido.'); }
}

const parseCookies = h => Object.fromEntries((h || '').split(';').map(s => s.trim().split(/=(.*)/s).slice(0, 2)).filter(p => p[0] && p[1] !== undefined));

function clientIp(req) {
  if (cfg.trustProxy) { const f = req.headers['x-forwarded-for']; if (f) return f.split(',')[0].trim(); }
  return req.socket.remoteAddress || 'desconocida';
}

const buckets = new Map();
/** true si la clave superó el límite de intentos dentro de la ventana */
function limited(key, max, windowMs) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  return ++b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60_000).unref();

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const safeEqual = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = v => (Number.isInteger(v) ? v : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN));

module.exports = { HttpError, json, readBody, readJson, parseCookies, clientIp, limited, sha256, safeEqual, str, int };
