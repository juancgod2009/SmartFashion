'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');

fs.mkdirSync(path.join(cfg.dataDir, 'uploads'), { recursive: true });
const db = new DatabaseSync(path.join(cfg.dataDir, 'smartfashion.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, nombre TEXT NOT NULL, categoria TEXT NOT NULL,
  desc_corta TEXT NOT NULL DEFAULT '', desc_larga TEXT NOT NULL DEFAULT '',
  precio INTEGER NOT NULL CHECK (precio > 0), precio_anterior INTEGER,
  estilos TEXT NOT NULL DEFAULT '[]', colores TEXT NOT NULL DEFAULT '[]', tallas TEXT NOT NULL DEFAULT '[]',
  material TEXT NOT NULL DEFAULT '', cuidados TEXT NOT NULL DEFAULT '',
  nuevo INTEGER NOT NULL DEFAULT 0, destacado INTEGER NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN ('publicado','borrador','archivado')),
  imagenes TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS variants (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE, color TEXT NOT NULL, talla TEXT NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0), PRIMARY KEY (product_id, color, talla));
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, codigo TEXT NOT NULL UNIQUE, token TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  estado TEXT NOT NULL, metodo_pago TEXT NOT NULL CHECK (metodo_pago IN ('wompi','manual')),
  nombre TEXT NOT NULL, correo TEXT NOT NULL, telefono TEXT NOT NULL, depto TEXT NOT NULL, ciudad TEXT NOT NULL,
  direccion TEXT NOT NULL, nota TEXT NOT NULL DEFAULT '',
  subtotal INTEGER NOT NULL, descuento INTEGER NOT NULL DEFAULT 0, envio INTEGER NOT NULL DEFAULT 0, envio_pendiente INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
  intentos INTEGER NOT NULL DEFAULT 0, wompi_tx_id TEXT, wompi_status TEXT,
  stock_devuelto INTEGER NOT NULL DEFAULT 0, nota_interna TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_orders_estado ON orders(estado);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL, nombre TEXT NOT NULL, color TEXT NOT NULL, talla TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0), precio INTEGER NOT NULL, precio_anterior INTEGER, imagen TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, nombre TEXT NOT NULL, correo TEXT NOT NULL, mensaje TEXT NOT NULL, leido INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS processed_events (key TEXT PRIMARY KEY, received_at TEXT NOT NULL);
`);

/** Transacción atómica: si algo falla, se revierte todo (p. ej. descuento de inventario). */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* ya revertida */ } throw e; }
}

/* ---------- Configuración editable desde el panel ---------- */
const DEFAULTS = {
  anuncio: 'Bienvenida a SmartFashion · La moda evoluciona contigo',
  envio: null, // { tarifa: 12000, gratisDesde: 150000 } — lo define el administrador
  contacto: { correo: '', telefono: '', whatsapp: '', instagram: '', tiktok: '', facebook: '', horario: '' },
  banner: { imagen: '', alt: '' },
  categorias: ['Camisetas', 'Blusas', 'Pantalones', 'Vestidos', 'Accesorios'],
  estilos: ['Casual', 'Elegante', 'Urbano', 'Deportivo', 'Minimalista', 'Ocasiones especiales'],
  guiaTallas: { S: 'Busto 84 · Cintura 66', M: 'Busto 90 · Cintura 72', L: 'Busto 96 · Cintura 78', XL: 'Busto 102 · Cintura 84' },
  pagoManual: '', // instrucciones de pago por transferencia / acuerdo con la tienda
  legales: { privacidad: '', terminos: '', devoluciones: '' }
};
function getSettings() {
  const out = structuredClone(DEFAULTS);
  for (const r of db.prepare('SELECT key, value FROM settings').all()) { try { if (r.key in DEFAULTS) out[r.key] = JSON.parse(r.value); } catch { /* ignora valor dañado */ } }
  return out;
}
const setSetting = (key, value) => db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));

/* ---------- Catálogo inicial (solo si la base está vacía) ---------- */
function seed() {
  if (!cfg.seedDemo || db.prepare('SELECT COUNT(*) n FROM products').get().n) return;
  const now = new Date().toISOString();
  const P = [
    ['SF-001', 'Camiseta básica algodón', 'Camisetas', 49900, null, ['Casual', 'Minimalista'], ['Negro', 'Blanco', 'Rosa'], ['S', 'M', 'L'], 6, 1, 1, 'Algodón 100%', 'Lavar a máquina en agua fría.', 'Corte recto y tela suave para el día a día.'],
    ['SF-002', 'Blusa satinada manga larga', 'Blusas', 89900, 119900, ['Elegante', 'Ocasiones especiales'], ['Rosa', 'Beige'], ['S', 'M', 'L'], 4, 0, 1, 'Poliéster satinado', 'Lavar a mano. No usar secadora.', 'Caída fluida y brillo discreto para oficina o salida.'],
    ['SF-003', 'Jean recto tiro alto', 'Pantalones', 129900, null, ['Casual', 'Urbano'], ['Azul', 'Negro'], ['S', 'M', 'L', 'XL'], 5, 1, 0, 'Denim con 2% elastano', 'Lavar del revés.', 'Silueta recta y cómoda, con tiro alto.'],
    ['SF-004', 'Vestido midi minimalista', 'Vestidos', 159900, 189900, ['Elegante', 'Minimalista', 'Ocasiones especiales'], ['Negro', 'Beige'], ['S', 'M', 'L'], 3, 0, 1, 'Crepé', 'Lavar a mano en agua fría.', 'Línea limpia que va de la universidad a la cena.'],
    ['SF-005', 'Top deportivo de soporte medio', 'Camisetas', 59900, null, ['Deportivo'], ['Negro', 'Rosa'], ['S', 'M', 'L'], 8, 1, 0, 'Poliamida y elastano', 'No usar suavizante.', 'Tela de secado rápido para entrenar o moverte.'],
    ['SF-006', 'Pantalón cargo urbano', 'Pantalones', 119900, null, ['Urbano', 'Casual'], ['Beige', 'Negro'], ['S', 'M', 'L'], 0, 0, 0, 'Gabardina de algodón', 'Lavar a máquina.', 'Bolsillos amplios y ajuste relajado.'],
    ['SF-007', 'Bolso bandolera', 'Accesorios', 79900, null, ['Casual', 'Minimalista'], ['Negro', 'Rosa'], ['Única'], 10, 0, 1, 'Cuero sintético', 'Limpiar con paño húmedo.', 'Compacto, con correa ajustable.'],
    ['SF-008', 'Blusa de lino con botones', 'Blusas', 94900, null, ['Casual', 'Elegante'], ['Blanco', 'Beige'], ['S', 'M', 'L'], 5, 1, 0, 'Mezcla lino-algodón', 'Planchar a temperatura media.', 'Fresca y ligera, con cuello camisero.']
  ];
  tx(() => {
    for (const [id, nombre, cat, precio, ant, est, col, tal, stock, nuevo, dest, mat, cui, desc] of P) {
      db.prepare(`INSERT INTO products(id,nombre,categoria,desc_corta,desc_larga,precio,precio_anterior,estilos,colores,tallas,material,cuidados,nuevo,destacado,estado,imagenes,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'publicado','[]',?,?)`).run(id, nombre, cat, desc, desc, precio, ant, JSON.stringify(est), JSON.stringify(col), JSON.stringify(tal), mat, cui, nuevo, dest, now, now);
      for (const c of col) for (const t of tal) db.prepare('INSERT INTO variants(product_id,color,talla,stock) VALUES (?,?,?,?)').run(id, c, t, stock);
    }
  });
}
seed();

module.exports = { db, tx, getSettings, setSetting, DEFAULTS };
