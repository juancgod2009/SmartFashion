'use strict';
const { db, tx, getSettings, setSetting } = require('./db');
const { HttpError, str, int } = require('./util');

const ESTADOS = ['publicado', 'borrador', 'archivado'];
const parse = s => { try { return JSON.parse(s); } catch { return []; } };

function toProduct(r, variantes, admin = false) {
  const p = {
    id: r.id, nombre: r.nombre, categoria: r.categoria, desc: r.desc_corta, descLarga: r.desc_larga || r.desc_corta,
    precio: r.precio, precioAnterior: r.precio_anterior && r.precio_anterior > r.precio ? r.precio_anterior : null,
    estilos: parse(r.estilos), colores: parse(r.colores), tallas: parse(r.tallas), material: r.material, cuidados: r.cuidados,
    nuevo: !!r.nuevo, destacado: !!r.destacado, imagenes: parse(r.imagenes), variantes,
    stock: variantes.reduce((s, v) => s + v.stock, 0)
  };
  if (admin) { p.estado = r.estado; p.precioAnterior = r.precio_anterior; p.updatedAt = r.updated_at; }
  return p;
}
function withVariants(rows, admin) {
  const vs = db.prepare('SELECT product_id, color, talla, stock FROM variants').all(), by = new Map();
  for (const v of vs) (by.get(v.product_id) || by.set(v.product_id, []).get(v.product_id)).push({ color: v.color, talla: v.talla, stock: v.stock });
  return rows.map(r => toProduct(r, by.get(r.id) || [], admin));
}
const listPublic = () => withVariants(db.prepare("SELECT * FROM products WHERE estado='publicado' ORDER BY nuevo DESC, created_at DESC, id").all(), false);
const listAdmin = () => withVariants(db.prepare('SELECT * FROM products ORDER BY created_at DESC, id').all(), true);
function getAdmin(id) {
  const r = db.prepare('SELECT * FROM products WHERE id=?').get(id); if (!r) return null;
  return toProduct(r, db.prepare('SELECT color, talla, stock FROM variants WHERE product_id=?').all(id), true);
}

const lista = (v, max, etiqueta) => {
  if (v === undefined || v === null) v = [];
  if (!Array.isArray(v)) throw new HttpError(400, `${etiqueta}: formato no válido.`);
  const out = [...new Set(v.map(x => str(x, 30)).filter(Boolean))];
  if (out.length > max) throw new HttpError(400, `${etiqueta}: máximo ${max} valores.`);
  return out;
};
const IMG_OK = /^\/(uploads\/[a-f0-9]{32}\.(jpg|png|webp)|assets\/images\/[\w\-./]{1,120}\.(jpg|jpeg|png|webp|svg))$/;

function validate(b, { crear }) {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'Datos no válidos.');
  const id = str(b.id, 30).toUpperCase();
  if (crear && !/^[A-Z0-9][A-Z0-9_-]{1,29}$/.test(id)) throw new HttpError(400, 'La referencia debe tener 2 a 30 caracteres (letras, números, guion).');
  const nombre = str(b.nombre, 120); if (nombre.length < 2) throw new HttpError(400, 'Escribe el nombre del producto.');
  const categoria = str(b.categoria, 40); if (!categoria) throw new HttpError(400, 'Elige o escribe una categoría.');
  const precio = int(b.precio); if (!(precio >= 100 && precio <= 50_000_000)) throw new HttpError(400, 'El precio debe ser un número entero en COP (mínimo 100).');
  let ant = b.precioAnterior === null || b.precioAnterior === '' || b.precioAnterior === undefined ? null : int(b.precioAnterior);
  if (ant !== null && !(ant > precio && ant <= 50_000_000)) throw new HttpError(400, 'El precio anterior debe ser mayor que el precio actual (o déjalo vacío).');
  const colores = lista(b.colores, 20, 'Colores'), tallas = lista(b.tallas, 20, 'Tallas'), estilos = lista(b.estilos, 12, 'Estilos');
  if (!colores.length || !tallas.length) throw new HttpError(400, 'Indica al menos un color y una talla.');
  const estado = ESTADOS.includes(b.estado) ? b.estado : 'borrador';
  const stocks = new Map();
  for (const v of Array.isArray(b.variantes) ? b.variantes : []) {
    const s = int(v?.stock); if (!(s >= 0 && s <= 100_000)) throw new HttpError(400, 'Las existencias deben ser enteros de 0 a 100000.');
    stocks.set(`${v.color}\u0000${v.talla}`, s);
  }
  const variantes = colores.flatMap(c => tallas.map(t => ({ color: c, talla: t, stock: stocks.get(`${c}\u0000${t}`) ?? 0 })));
  const imagenes = (Array.isArray(b.imagenes) ? b.imagenes : []).slice(0, 10).map(i => ({ url: str(i?.url, 200), alt: str(i?.alt, 150) }));
  if (imagenes.some(i => !IMG_OK.test(i.url))) throw new HttpError(400, 'Una de las imágenes tiene una ruta no permitida. Súbela con el botón de carga.');
  return { id, nombre, categoria, desc: str(b.desc, 300), descLarga: str(b.descLarga, 4000), precio, ant, estilos, colores, tallas, material: str(b.material, 150), cuidados: str(b.cuidados, 300), nuevo: b.nuevo ? 1 : 0, destacado: b.destacado ? 1 : 0, estado, variantes, imagenes };
}

function asegurarCategoria(cat) {
  const s = getSettings();
  if (!s.categorias.includes(cat)) setSetting('categorias', [...s.categorias, cat]);
}

function saveVariants(id, variantes) {
  db.prepare('DELETE FROM variants WHERE product_id=?').run(id);
  for (const v of variantes) db.prepare('INSERT INTO variants(product_id,color,talla,stock) VALUES (?,?,?,?)').run(id, v.color, v.talla, v.stock);
}

function create(body) {
  const p = validate(body, { crear: true }), now = new Date().toISOString();
  tx(() => {
    if (db.prepare('SELECT 1 FROM products WHERE id=?').get(p.id)) throw new HttpError(409, 'Ya existe un producto con esa referencia.');
    db.prepare(`INSERT INTO products(id,nombre,categoria,desc_corta,desc_larga,precio,precio_anterior,estilos,colores,tallas,material,cuidados,nuevo,destacado,estado,imagenes,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.id, p.nombre, p.categoria, p.desc, p.descLarga, p.precio, p.ant, JSON.stringify(p.estilos), JSON.stringify(p.colores), JSON.stringify(p.tallas), p.material, p.cuidados, p.nuevo, p.destacado, p.estado, JSON.stringify(p.imagenes), now, now);
    saveVariants(p.id, p.variantes);
  });
  asegurarCategoria(p.categoria);
  return getAdmin(p.id);
}

function update(id, body) {
  const p = validate(body, { crear: false }), now = new Date().toISOString();
  tx(() => {
    if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(id)) throw new HttpError(404, 'Producto no encontrado.');
    db.prepare(`UPDATE products SET nombre=?,categoria=?,desc_corta=?,desc_larga=?,precio=?,precio_anterior=?,estilos=?,colores=?,tallas=?,material=?,cuidados=?,nuevo=?,destacado=?,estado=?,imagenes=?,updated_at=? WHERE id=?`)
      .run(p.nombre, p.categoria, p.desc, p.descLarga, p.precio, p.ant, JSON.stringify(p.estilos), JSON.stringify(p.colores), JSON.stringify(p.tallas), p.material, p.cuidados, p.nuevo, p.destacado, p.estado, JSON.stringify(p.imagenes), now, id);
    saveVariants(id, p.variantes);
  });
  asegurarCategoria(p.categoria);
  return getAdmin(id);
}

/** Si el producto tiene pedidos, se ARCHIVA (se conserva el historial); si no, se elimina. */
function remove(id) {
  return tx(() => {
    if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(id)) throw new HttpError(404, 'Producto no encontrado.');
    if (db.prepare('SELECT 1 FROM order_items WHERE product_id=? LIMIT 1').get(id)) {
      db.prepare("UPDATE products SET estado='archivado', updated_at=? WHERE id=?").run(new Date().toISOString(), id);
      return { accion: 'archivado' };
    }
    db.prepare('DELETE FROM products WHERE id=?').run(id);
    return { accion: 'eliminado' };
  });
}

module.exports = { listPublic, listAdmin, getAdmin, create, update, remove };
