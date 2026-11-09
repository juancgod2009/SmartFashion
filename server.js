'use strict';
/* SmartFashion · servidor HTTP sin dependencias externas (Node.js >= 22.13). */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const cfg = require('./lib/config');
const { db, getSettings, setSetting } = require('./lib/db');
const auth = require('./lib/auth');
const products = require('./lib/products');
const orders = require('./lib/orders');
const wompi = require('./lib/wompi');
const { HttpError, json, readBody, readJson, clientIp, limited, str, int } = require('./lib/util');

const PUBLIC = path.join(__dirname, 'public');
const UPLOADS = path.join(cfg.dataDir, 'uploads');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const SEC = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  ...(cfg.prod ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {})
};

/* ---------- Rutas ---------- */
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, ...opts });

function configPublica() {
  const s = getSettings();
  return {
    anuncio: s.anuncio, contacto: s.contacto, banner: s.banner, categorias: s.categorias, estilos: s.estilos, guiaTallas: s.guiaTallas,
    envio: s.envio && Number.isInteger(s.envio.tarifa) ? s.envio : null,
    pagos: { wompi: cfg.wompi.enabled && !!(s.envio && Number.isInteger(s.envio.tarifa)), pruebas: cfg.wompi.enabled && cfg.wompi.sandbox, manual: s.pagoManual },
    legales: Object.fromEntries(Object.entries(s.legales).map(([k, v]) => [k, !!v]))
  };
}
route('GET', '/api/catalogo', ({ res }) => json(res, 200, { config: configPublica(), productos: products.listPublic() }));
route('GET', '/api/legal/:k', ({ res, params }) => {
  const t = getSettings().legales[params.k]; if (!t) throw new HttpError(404, 'Documento no disponible.');
  json(res, 200, { texto: t });
});

route('POST', '/api/pedidos', async ({ req, res, ip }) => {
  if (limited('pedido:' + ip, 10, 10 * 60_000)) throw new HttpError(429, 'Demasiados intentos. Espera unos minutos.');
  const body = await readJson(req, 100_000);
  const r = orders.crear(body);
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(r.id);
  let checkoutUrl = null;
  if (r.metodo === 'wompi') checkoutUrl = orders.iniciarPagoWompi(r.codigo);
  json(res, 201, { codigo: r.codigo, token: r.token, estado: o.estado, checkoutUrl });
});
route('POST', '/api/pedidos/consulta', async ({ req, res, ip }) => {
  if (limited('consulta:' + ip, 30, 10 * 60_000)) throw new HttpError(429, 'Demasiadas consultas. Espera unos minutos.');
  const b = await readJson(req, 10_000);
  json(res, 200, orders.publico(orders.consultar(b.codigo, { token: str(b.token, 60), correo: b.correo })));
});
route('POST', '/api/pedidos/pagar', async ({ req, res, ip }) => {
  if (limited('pagar:' + ip, 15, 10 * 60_000)) throw new HttpError(429, 'Demasiados intentos. Espera unos minutos.');
  const b = await readJson(req, 10_000);
  const o = orders.consultar(b.codigo, { token: str(b.token, 60), correo: b.correo });
  json(res, 200, { checkoutUrl: orders.iniciarPagoWompi(o.codigo) });
});
route('POST', '/api/contacto', async ({ req, res, ip }) => {
  if (limited('contacto:' + ip, 5, 10 * 60_000)) throw new HttpError(429, 'Ya enviaste varios mensajes. Intenta más tarde.');
  const b = await readJson(req, 20_000);
  const nombre = str(b.nombre, 100), correo = str(b.correo, 120), mensaje = str(b.mensaje, 2000);
  if (nombre.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo) || mensaje.length < 10) throw new HttpError(400, 'Completa tu nombre, un correo válido y un mensaje de al menos 10 caracteres.');
  db.prepare('INSERT INTO messages(created_at,nombre,correo,mensaje) VALUES (?,?,?,?)').run(new Date().toISOString(), nombre, correo, mensaje);
  json(res, 201, { ok: true });
});

/* Retorno desde Wompi: se consulta la transacción en Wompi (no se confía en la URL). */
route('GET', '/pago/retorno', async ({ res, url }) => {
  const codigo = str(url.searchParams.get('codigo'), 20), t = str(url.searchParams.get('t'), 60), txId = str(url.searchParams.get('id'), 80);
  if (txId && cfg.wompi.enabled) {
    try { orders.aplicarTransaccionWompi(await wompi.consultarTransaccion(txId)); }
    catch (e) { console.error('[wompi] no se pudo verificar la transacción', txId, e.message); }
  }
  res.writeHead(302, { Location: `/#/seguimiento/${encodeURIComponent(codigo)}?t=${encodeURIComponent(t)}`, 'Cache-Control': 'no-store' }); res.end();
});
route('POST', '/api/wompi/webhook', async ({ req, res }) => {
  if (!cfg.wompi.enabled) throw new HttpError(404, 'No disponible.');
  const body = await readJson(req, 100_000);
  if (!wompi.verificarEvento(body, req.headers['x-event-checksum'])) throw new HttpError(401, 'Firma no válida.');
  const t = body?.data?.transaction;
  if (body.event === 'transaction.updated' && t) {
    const key = `${t.id}:${t.status}:${body.timestamp}`;
    if (orders.marcarEventoProcesado(key)) orders.aplicarTransaccionWompi(t);
  }
  json(res, 200, { ok: true });
});

/* ---------- Administración (todo se valida en el servidor) ---------- */
route('POST', '/api/admin/login', async ({ req, res, ip }) => {
  const b = await readJson(req, 5_000), email = str(b.email, 120).toLowerCase();
  if (limited('login:' + ip, 10, 15 * 60_000) || limited('loginm:' + email, 6, 15 * 60_000)) throw new HttpError(429, 'Demasiados intentos. Espera 15 minutos.');
  const a = db.prepare('SELECT * FROM admins WHERE email=?').get(email);
  const ok = await auth.verifyPassword(String(b.password || ''), a ? a.hash : await auth.dummyHash());
  if (!a || !ok) throw new HttpError(401, 'Correo o contraseña incorrectos.');
  const s = auth.createSession(a.id);
  json(res, 200, { email: a.email, csrf: s.csrf }, { 'Set-Cookie': auth.cookieHeader(s.token) });
});
const admin = (method, pattern, handler) => route(method, pattern, handler, { admin: true });
admin('GET', '/api/admin/me', ({ res, session }) => json(res, 200, { email: session.email, csrf: session.csrf, estados: orders.ESTADOS, wompi: { activo: cfg.wompi.enabled, pruebas: cfg.wompi.sandbox } }));
admin('POST', '/api/admin/logout', ({ res, session }) => { auth.destroySession(session.sid); json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() }); });
admin('POST', '/api/admin/password', async ({ req, res, session }) => {
  const b = await readJson(req, 5_000), a = db.prepare('SELECT * FROM admins WHERE id=?').get(session.adminId);
  if (!(await auth.verifyPassword(String(b.actual || ''), a.hash))) throw new HttpError(400, 'La contraseña actual no es correcta.');
  const bad = auth.validarPassword(b.nueva); if (bad) throw new HttpError(400, bad);
  db.prepare('UPDATE admins SET hash=? WHERE id=?').run(await auth.hashPassword(b.nueva), a.id);
  db.prepare('DELETE FROM sessions WHERE admin_id=? AND id<>?').run(a.id, session.sid);
  json(res, 200, { ok: true });
});
admin('GET', '/api/admin/productos', ({ res }) => json(res, 200, products.listAdmin()));
admin('POST', '/api/admin/productos', async ({ req, res }) => json(res, 201, products.create(await readJson(req, 200_000))));
admin('GET', '/api/admin/productos/:id', ({ res, params }) => { const p = products.getAdmin(params.id); if (!p) throw new HttpError(404, 'Producto no encontrado.'); json(res, 200, p); });
admin('PUT', '/api/admin/productos/:id', async ({ req, res, params }) => json(res, 200, products.update(params.id, await readJson(req, 200_000))));
admin('DELETE', '/api/admin/productos/:id', ({ res, params }) => json(res, 200, products.remove(params.id)));

const MAGIC = [[Buffer.from([0xff, 0xd8, 0xff]), 'jpg'], [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'png']];
admin('POST', '/api/admin/upload', async ({ req, res }) => {
  const buf = await readBody(req, 5 * 1024 * 1024);
  if (!buf.length) throw new HttpError(400, 'No se recibió ningún archivo.');
  let ext = MAGIC.find(([m]) => buf.subarray(0, m.length).equals(m))?.[1];
  if (!ext && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') ext = 'webp';
  if (!ext) throw new HttpError(400, 'Solo se aceptan imágenes JPG, PNG o WEBP de hasta 5 MB.');
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext; // nombre aleatorio: nunca se usa el del usuario
  fs.writeFileSync(path.join(UPLOADS, name), buf, { flag: 'wx' });
  json(res, 201, { url: '/uploads/' + name });
});

admin('GET', '/api/admin/pedidos', ({ res, url }) => json(res, 200, orders.listarAdmin({ estado: url.searchParams.get('estado'), q: url.searchParams.get('q') })));
admin('GET', '/api/admin/pedidos/:id', ({ res, params }) => { const o = orders.obtenerAdmin(int(params.id)); if (!o) throw new HttpError(404, 'Pedido no encontrado.'); json(res, 200, o); });
admin('PUT', '/api/admin/pedidos/:id', async ({ req, res, params }) => { const b = await readJson(req, 10_000); json(res, 200, orders.cambiarEstado(int(params.id), str(b.estado, 40), b.notaInterna)); });

const num = v => (v === '' || v === null || v === undefined ? null : int(v));
admin('GET', '/api/admin/config', ({ res }) => json(res, 200, getSettings()));
admin('PUT', '/api/admin/config', async ({ req, res }) => {
  const b = await readJson(req, 100_000), s = getSettings();
  const list = (v, max) => [...new Set((Array.isArray(v) ? v : []).map(x => str(x, 40)).filter(Boolean))].slice(0, max);
  if ('anuncio' in b) setSetting('anuncio', str(b.anuncio, 200));
  if ('envio' in b) {
    const t = num(b.envio?.tarifa), g = num(b.envio?.gratisDesde);
    if (t !== null && !(t >= 0 && t <= 1_000_000)) throw new HttpError(400, 'La tarifa de envío no es válida.');
    if (g !== null && !(g >= 0)) throw new HttpError(400, 'El valor de envío gratis no es válido.');
    setSetting('envio', t === null ? null : { tarifa: t, gratisDesde: g });
  }
  if (b.contacto) {
    const c = b.contacto, link = v => { v = str(v, 200); if (v && !/^https:\/\//i.test(v)) throw new HttpError(400, 'Los enlaces de redes sociales deben empezar con https://'); return v; };
    const correo = str(c.correo, 120); if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) throw new HttpError(400, 'El correo de contacto no es válido.');
    setSetting('contacto', { correo, telefono: str(c.telefono, 30), whatsapp: str(c.whatsapp, 20).replace(/[^\d+]/g, ''), instagram: link(c.instagram), tiktok: link(c.tiktok), facebook: link(c.facebook), horario: str(c.horario, 120) });
  }
  if (b.banner) {
    const u = str(b.banner.imagen, 200); if (u && !/^\/(uploads\/[a-f0-9]{32}\.(jpg|png|webp)|assets\/images\/[\w\-./]{1,120})$/.test(u)) throw new HttpError(400, 'Ruta de imagen no permitida.');
    setSetting('banner', { imagen: u, alt: str(b.banner.alt, 150) });
  }
  if ('categorias' in b) setSetting('categorias', list(b.categorias, 30));
  if ('estilos' in b) setSetting('estilos', list(b.estilos, 30));
  if (b.guiaTallas && typeof b.guiaTallas === 'object') setSetting('guiaTallas', Object.fromEntries(Object.entries(b.guiaTallas).slice(0, 20).map(([k, v]) => [str(k, 10), str(v, 80)]).filter(([k, v]) => k && v)));
  if ('pagoManual' in b) setSetting('pagoManual', str(b.pagoManual, 1500));
  if (b.legales) setSetting('legales', { privacidad: str(b.legales.privacidad, 30000), terminos: str(b.legales.terminos, 30000), devoluciones: str(b.legales.devoluciones, 30000) });
  json(res, 200, getSettings());
});
admin('GET', '/api/admin/mensajes', ({ res }) => json(res, 200, db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 200').all()));
admin('PUT', '/api/admin/mensajes/:id', ({ res, params }) => { db.prepare('UPDATE messages SET leido=1 WHERE id=?').run(int(params.id)); json(res, 200, { ok: true }); });
admin('DELETE', '/api/admin/mensajes/:id', ({ res, params }) => { db.prepare('DELETE FROM messages WHERE id=?').run(int(params.id)); json(res, 200, { ok: true }); });

/* ---------- Archivos estáticos ---------- */
const gzCache = new Map();
function serveFile(req, res, file, { cache }) {
  let st; try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(file).toLowerCase(), type = MIME[ext]; if (!type) return false;
  const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
  const h = { 'Content-Type': type, ETag: etag, 'Cache-Control': cache, ...SEC };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, h); res.end(); return true; }
  const texto = /\.(html|css|js|svg|json|webmanifest|txt)$/.test(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (req.method === 'HEAD') { res.writeHead(200, h); res.end(); return true; }
  if (texto) {
    let c = gzCache.get(file); if (!c || c.etag !== etag) { c = { etag, buf: zlib.gzipSync(fs.readFileSync(file)) }; gzCache.set(file, c); }
    res.writeHead(200, { ...h, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': c.buf.length }); res.end(c.buf);
  } else { res.writeHead(200, { ...h, 'Content-Length': st.size }); fs.createReadStream(file).pipe(res); }
  return true;
}
function serveStatic(req, res, pathname) {
  let rel; try { rel = decodeURIComponent(pathname); } catch { return false; }
  if (rel.includes('\0')) return false;
  if (rel === '/admin' || rel === '/admin/') return serveFile(req, res, path.join(PUBLIC, 'admin.html'), { cache: 'no-cache' });
  if (rel.startsWith('/uploads/')) {
    const f = path.join(UPLOADS, path.basename(rel));
    return /^[a-f0-9]{32}\.(jpg|png|webp)$/.test(path.basename(rel)) && serveFile(req, res, f, { cache: 'public, max-age=604800, immutable' });
  }
  if (rel === '/') rel = '/index.html';
  const f = path.normalize(path.join(PUBLIC, rel));
  if (!f.startsWith(PUBLIC + path.sep)) return false;
  return serveFile(req, res, f, { cache: /\.(html)$/.test(f) ? 'no-cache' : 'public, max-age=3600' });
}

/* ---------- Servidor ---------- */
const server = http.createServer(async (req, res) => {
  try {
    for (const [k, v] of Object.entries(SEC)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://x'), ip = clientIp(req);
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    for (const r of routes) {
      const m = r.method === method && r.re.exec(url.pathname); if (!m) continue;
      const ctx = { req, res, url, ip, params: m.groups || {} };
      if (r.admin) {
        ctx.session = auth.getSession(req);
        if (!ctx.session) throw new HttpError(401, 'Inicia sesión para continuar.');
        if (method !== 'GET') {
          const origin = req.headers.origin; // defensa extra contra solicitudes desde otros sitios
          if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origen no permitido.');
          if (req.headers['x-csrf-token'] !== ctx.session.csrf) throw new HttpError(403, 'Sesión no válida. Recarga la página.');
        }
      } else if (method === 'POST' && url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (origin && url.pathname !== '/api/wompi/webhook' && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origen no permitido.');
      }
      return await r.handler(ctx);
    }
    if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'Recurso no encontrado.');
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, url.pathname)) return;
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;text-align:center;padding:4rem 1rem"><h1>Página no encontrada</h1><p><a href="/">Volver a SmartFashion</a></p>');
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return json(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error('[error]', req.method, req.url, e);
    json(res, 500, { error: 'Ocurrió un error inesperado. Intenta de nuevo.' });
  }
});

async function arrancar() {
  if (!db.prepare('SELECT 1 FROM admins LIMIT 1').get() && cfg.adminEmail && cfg.adminPassword) {
    try { await auth.crearAdmin(cfg.adminEmail, cfg.adminPassword); console.log(`[admin] Cuenta administradora creada: ${cfg.adminEmail}. Borra ADMIN_PASSWORD de las variables de entorno.`); }
    catch (e) { console.error('[admin] No se pudo crear la cuenta inicial:', e.message); }
  }
  if (!db.prepare('SELECT 1 FROM admins LIMIT 1').get()) console.warn('[admin] Aún no existe una cuenta administradora. Ejecuta: npm run crear-admin');
  if (cfg.prod && !/^https:/.test(cfg.baseUrl)) console.warn('[config] BASE_URL debería ser https:// en producción.');
  console.log(`[pagos] Wompi: ${cfg.wompi.enabled ? (cfg.wompi.sandbox ? 'ACTIVO (modo pruebas)' : 'ACTIVO (producción)') : 'sin credenciales — solo pago manual'}`);
  orders.expirarPendientes();
  setInterval(() => { try { orders.expirarPendientes(); } catch (e) { console.error('[expirar]', e); } }, 15 * 60_000).unref();
  server.listen(cfg.port, cfg.host, () => console.log(`SmartFashion en ${cfg.baseUrl}  (puerto ${cfg.port})`));
}
if (require.main === module) arrancar(); else module.exports = { server, arrancar };
const salir = () => server.close(() => process.exit(0));
process.on('SIGTERM', salir); process.on('SIGINT', salir);
