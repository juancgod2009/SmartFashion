'use strict';
const crypto = require('node:crypto');
const { db, tx, getSettings } = require('./db');
const cfg = require('./config');
const wompi = require('./wompi');
const { HttpError, str, int, safeEqual } = require('./util');

const ESTADOS = ['Pendiente de pago', 'Pago pendiente de confirmación', 'Pagado', 'En preparación', 'Enviado', 'Entregado', 'Cancelado', 'Reembolsado'];
const SIGUIENTES = {
  'Pendiente de pago': ['Pago pendiente de confirmación', 'Pagado', 'Cancelado'],
  'Pago pendiente de confirmación': ['Pendiente de pago', 'Pagado', 'Cancelado'],
  'Pagado': ['En preparación', 'Enviado', 'Cancelado', 'Reembolsado'],
  'En preparación': ['Enviado', 'Cancelado', 'Reembolsado'],
  'Enviado': ['Entregado', 'Reembolsado'],
  'Entregado': ['Reembolsado'],
  'Cancelado': [], 'Reembolsado': []
};
const PENDIENTES = ['Pendiente de pago', 'Pago pendiente de confirmación'];
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const nuevoCodigo = () => 'SF-' + Array.from({ length: 8 }, () => ALFABETO[crypto.randomInt(ALFABETO.length)]).join('');

/** Costo de envío según la configuración del administrador. null = sin tarifa configurada. */
function calcularEnvio(subtotal, envio) {
  if (!envio || !Number.isInteger(envio.tarifa)) return null;
  return Number.isInteger(envio.gratisDesde) && envio.gratisDesde > 0 && subtotal >= envio.gratisDesde ? 0 : envio.tarifa;
}

function validarCliente(c) {
  c = c && typeof c === 'object' ? c : {};
  const d = { nombre: str(c.nombre, 100), correo: str(c.correo, 120).toLowerCase(), telefono: str(c.telefono, 20), depto: str(c.depto, 60), ciudad: str(c.ciudad, 80), direccion: str(c.direccion, 160), nota: str(c.nota, 300) };
  const e = {};
  if (d.nombre.length < 3) e.nombre = 'Escribe tu nombre completo.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.correo)) e.correo = 'Escribe un correo válido.';
  if (!/^[0-9+\s-]{7,20}$/.test(d.telefono)) e.telefono = 'Escribe un teléfono válido (7 a 15 dígitos).';
  if (d.depto.length < 3) e.depto = 'Escribe el departamento.';
  if (d.ciudad.length < 2) e.ciudad = 'Escribe la ciudad o municipio.';
  if (d.direccion.length < 5) e.direccion = 'Escribe la dirección de entrega.';
  if (Object.keys(e).length) throw new HttpError(400, 'Revisa los datos marcados.', { campos: e });
  return d;
}

function crear(input) {
  const cliente = validarCliente(input.cliente);
  const metodo = input.metodoPago === 'wompi' ? 'wompi' : input.metodoPago === 'manual' ? 'manual' : '';
  if (!metodo) throw new HttpError(400, 'Elige un método de pago.');
  if (metodo === 'wompi' && !cfg.wompi.enabled) throw new HttpError(400, 'El pago en línea no está disponible en este momento.');
  const settings = getSettings();
  if (metodo === 'wompi' && calcularEnvio(0, settings.envio) === null) throw new HttpError(400, 'El pago en línea no está disponible mientras no se configure el envío.');

  // Une líneas repetidas y valida cantidades
  const merged = new Map();
  for (const l of Array.isArray(input.items) ? input.items : []) {
    const qty = int(l?.qty), key = `${l?.id}\u0000${l?.color}\u0000${l?.talla}`;
    if (!(qty >= 1 && qty <= 20)) throw new HttpError(400, 'Las cantidades deben ser números enteros de 1 a 20.');
    merged.set(key, { id: str(l.id, 30), color: str(l.color, 30), talla: str(l.talla, 30), qty: (merged.get(key)?.qty || 0) + qty });
  }
  if (!merged.size) throw new HttpError(400, 'Tu carrito está vacío.');
  if (merged.size > 30) throw new HttpError(400, 'El pedido tiene demasiados artículos.');

  const now = new Date().toISOString(), token = crypto.randomBytes(18).toString('base64url');
  return tx(() => {
    const items = [];
    for (const l of merged.values()) {
      const p = db.prepare("SELECT * FROM products WHERE id=? AND estado='publicado'").get(l.id);
      if (!p) throw new HttpError(409, 'Uno de los productos de tu carrito ya no está disponible. Revisa el carrito.', { refrescar: true });
      const upd = db.prepare('UPDATE variants SET stock = stock - ? WHERE product_id=? AND color=? AND talla=? AND stock >= ?').run(l.qty, l.id, l.color, l.talla, l.qty);
      if (upd.changes !== 1) throw new HttpError(409, `No hay suficientes unidades de «${p.nombre}» (${l.color}, talla ${l.talla}). Revisa el carrito.`, { refrescar: true });
      let imgs = []; try { imgs = JSON.parse(p.imagenes); } catch { /* sin imágenes */ }
      items.push({ product_id: p.id, nombre: p.nombre, color: l.color, talla: l.talla, qty: l.qty, precio: p.precio, precio_anterior: p.precio_anterior && p.precio_anterior > p.precio ? p.precio_anterior : null, imagen: imgs[0]?.url || '' });
    }
    const subtotal = items.reduce((s, i) => s + i.precio * i.qty, 0);
    const descuento = items.reduce((s, i) => s + (i.precio_anterior ? (i.precio_anterior - i.precio) * i.qty : 0), 0);
    const envio = calcularEnvio(subtotal, settings.envio);
    const total = subtotal + (envio || 0);
    let codigo, id;
    for (let i = 0; i < 5; i++) {
      codigo = nuevoCodigo();
      try {
        id = db.prepare(`INSERT INTO orders(codigo,token,created_at,updated_at,estado,metodo_pago,nombre,correo,telefono,depto,ciudad,direccion,nota,subtotal,descuento,envio,envio_pendiente,total)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(codigo, token, now, now, 'Pendiente de pago', metodo, cliente.nombre, cliente.correo, cliente.telefono, cliente.depto, cliente.ciudad, cliente.direccion, cliente.nota, subtotal, descuento, envio || 0, envio === null ? 1 : 0, total).lastInsertRowid;
        break;
      } catch (e) { if (i === 4 || !/UNIQUE/.test(e.message)) throw e; }
    }
    for (const i of items) db.prepare('INSERT INTO order_items(order_id,product_id,nombre,color,talla,qty,precio,precio_anterior,imagen) VALUES (?,?,?,?,?,?,?,?,?)').run(id, i.product_id, i.nombre, i.color, i.talla, i.qty, i.precio, i.precio_anterior, i.imagen);
    return { id, codigo, token, metodo };
  });
}

/** Prepara el pago en Wompi. Cada intento usa una referencia nueva (CODIGO-1, CODIGO-2...). */
function iniciarPagoWompi(codigo) {
  if (!cfg.wompi.enabled) throw new HttpError(400, 'El pago en línea no está disponible.');
  const o = db.prepare('SELECT * FROM orders WHERE codigo=?').get(codigo);
  if (!o || o.metodo_pago !== 'wompi') throw new HttpError(404, 'Pedido no encontrado.');
  if (o.estado !== 'Pendiente de pago') throw new HttpError(409, 'Este pedido ya no admite un nuevo intento de pago.');
  const intento = o.intentos + 1;
  db.prepare('UPDATE orders SET intentos=?, updated_at=? WHERE id=?').run(intento, new Date().toISOString(), o.id);
  return wompi.checkoutUrl(o, intento);
}

const itemsDe = id => db.prepare('SELECT product_id, nombre, color, talla, qty, precio, precio_anterior, imagen FROM order_items WHERE order_id=?').all(id);
function publico(o) {
  return {
    codigo: o.codigo, fecha: o.created_at, estado: o.estado, metodoPago: o.metodo_pago, wompiStatus: o.wompi_status,
    nombre: o.nombre, ciudad: o.ciudad, subtotal: o.subtotal, descuento: o.descuento, envio: o.envio, envioPendiente: !!o.envio_pendiente, total: o.total,
    puedeReintentar: o.metodo_pago === 'wompi' && o.estado === 'Pendiente de pago' && cfg.wompi.enabled,
    items: itemsDe(o.id).map(i => ({ nombre: i.nombre, color: i.color, talla: i.talla, qty: i.qty, precio: i.precio, imagen: i.imagen }))
  };
}
/** Consulta del comprador: requiere el token del pedido o el correo con el que compró. */
function consultar(codigo, { token, correo }) {
  const o = db.prepare('SELECT * FROM orders WHERE codigo=?').get(str(codigo, 20).toUpperCase());
  const ok = o && ((token && safeEqual(token, o.token)) || (correo && safeEqual(str(correo, 120).toLowerCase(), o.correo)));
  if (!ok) throw new HttpError(404, 'No encontramos un pedido con esos datos.');
  return o;
}

function devolverStock(o) {
  if (o.stock_devuelto) return;
  for (const i of itemsDe(o.id)) db.prepare('UPDATE variants SET stock = stock + ? WHERE product_id=? AND color=? AND talla=?').run(i.qty, i.product_id, i.color, i.talla);
  db.prepare('UPDATE orders SET stock_devuelto=1 WHERE id=?').run(o.id);
}
function retomarStock(o) { // pago aprobado después de cancelar/expirar
  let faltante = false;
  for (const i of itemsDe(o.id)) {
    const r = db.prepare('UPDATE variants SET stock = stock - ? WHERE product_id=? AND color=? AND talla=? AND stock >= ?').run(i.qty, i.product_id, i.color, i.talla, i.qty);
    if (r.changes !== 1) faltante = true;
  }
  if (!faltante) db.prepare('UPDATE orders SET stock_devuelto=0 WHERE id=?').run(o.id);
  return faltante;
}

/** Aplica el resultado de una transacción de Wompi. Es idempotente: repetirlo no duplica nada. */
function aplicarTransaccionWompi(t) {
  if (!t || !t.reference) return { ignorado: 'sin referencia' };
  const o = db.prepare('SELECT * FROM orders WHERE codigo=?').get(wompi.codigoDeReferencia(t.reference));
  if (!o || o.metodo_pago !== 'wompi') return { ignorado: 'pedido desconocido' };
  if (t.amount_in_cents !== o.total * 100 || (t.currency && t.currency !== 'COP')) {
    db.prepare("UPDATE orders SET nota_interna = nota_interna || ? WHERE id=?").run(`\n[${new Date().toISOString()}] ALERTA: Wompi reportó un monto distinto (${t.amount_in_cents}) para la transacción ${t.id}. No se aplicó.`, o.id);
    return { ignorado: 'monto no coincide' };
  }
  if (o.wompi_tx_id === t.id && o.wompi_status === t.status) return { ignorado: 'ya procesada' };
  const ahora = new Date().toISOString();
  return tx(() => {
    const cur = db.prepare('SELECT * FROM orders WHERE id=?').get(o.id);
    let estado = cur.estado, nota = '';
    if (t.status === 'APPROVED') {
      if (PENDIENTES.includes(cur.estado)) estado = 'Pagado';
      else if (cur.estado === 'Cancelado') {
        estado = 'Pagado';
        nota = retomarStock(cur) ? '\n[' + ahora + '] ATENCIÓN: el pago se aprobó después de cancelarse el pedido y NO hay inventario suficiente. Contacta a la clienta o reembolsa desde Wompi.'
          : '\n[' + ahora + '] El pago se aprobó después de cancelarse el pedido; se volvió a reservar el inventario.';
      }
    } else if (t.status === 'PENDING') { if (cur.estado === 'Pendiente de pago') estado = 'Pago pendiente de confirmación'; }
    else if (['DECLINED', 'ERROR', 'VOIDED'].includes(t.status)) { if (cur.estado === 'Pago pendiente de confirmación') estado = 'Pendiente de pago'; }
    db.prepare('UPDATE orders SET estado=?, wompi_tx_id=?, wompi_status=?, nota_interna = nota_interna || ?, updated_at=? WHERE id=?').run(estado, t.id, t.status, nota, ahora, o.id);
    return { codigo: o.codigo, estado, wompi: t.status };
  });
}

function marcarEventoProcesado(key) {
  return db.prepare('INSERT OR IGNORE INTO processed_events(key, received_at) VALUES (?,?)').run(key, new Date().toISOString()).changes === 1;
}

/* ---------- Administración ---------- */
function listarAdmin({ estado, q }) {
  const w = [], a = [];
  if (estado && ESTADOS.includes(estado)) { w.push('estado=?'); a.push(estado); }
  if (q) { w.push('(codigo LIKE ? OR nombre LIKE ? OR correo LIKE ?)'); a.push(...Array(3).fill(`%${str(q, 60)}%`)); }
  const rows = db.prepare(`SELECT * FROM orders ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`).all(...a);
  return rows.map(o => ({ ...detalleAdmin(o), items: undefined, nItems: itemsDe(o.id).reduce((s, i) => s + i.qty, 0) }));
}
function detalleAdmin(o) {
  return { id: o.id, codigo: o.codigo, fecha: o.created_at, estado: o.estado, siguientes: SIGUIENTES[o.estado] || [], metodoPago: o.metodo_pago, wompiStatus: o.wompi_status, wompiTx: o.wompi_tx_id,
    nombre: o.nombre, correo: o.correo, telefono: o.telefono, depto: o.depto, ciudad: o.ciudad, direccion: o.direccion, nota: o.nota,
    subtotal: o.subtotal, descuento: o.descuento, envio: o.envio, envioPendiente: !!o.envio_pendiente, total: o.total, notaInterna: o.nota_interna, items: itemsDe(o.id) };
}
function obtenerAdmin(id) { const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id); return o ? detalleAdmin(o) : null; }

function cambiarEstado(id, nuevo, notaInterna) {
  return tx(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    if (!o) throw new HttpError(404, 'Pedido no encontrado.');
    if (nuevo !== o.estado) {
      if (!ESTADOS.includes(nuevo) || !SIGUIENTES[o.estado].includes(nuevo)) throw new HttpError(400, `No se puede pasar de «${o.estado}» a «${nuevo}».`);
      if (nuevo === 'Pagado' && o.metodo_pago === 'wompi') throw new HttpError(400, 'Los pagos de Wompi se marcan como pagados únicamente cuando Wompi lo confirma.');
      if (nuevo === 'Cancelado') devolverStock(o);
    }
    const nota = notaInterna === undefined ? o.nota_interna : str(notaInterna, 2000);
    db.prepare('UPDATE orders SET estado=?, nota_interna=?, updated_at=? WHERE id=?').run(nuevo, nota, new Date().toISOString(), id);
    return obtenerAdmin(id);
  });
}

/** Libera el inventario de pedidos de pago en línea que nadie pagó dentro del plazo. */
function expirarPendientes() {
  const limite = new Date(Date.now() - cfg.reservaHoras * 3600_000).toISOString();
  const rows = db.prepare("SELECT * FROM orders WHERE metodo_pago='wompi' AND estado='Pendiente de pago' AND created_at < ?").all(limite);
  for (const o of rows) tx(() => { devolverStock(o); db.prepare("UPDATE orders SET estado='Cancelado', nota_interna = nota_interna || ?, updated_at=? WHERE id=?").run(`\n[${new Date().toISOString()}] Cancelado automáticamente: no se recibió el pago en ${cfg.reservaHoras} h.`, new Date().toISOString(), o.id); });
  return rows.length;
}

module.exports = { ESTADOS, crear, iniciarPagoWompi, consultar, publico, aplicarTransaccionWompi, marcarEventoProcesado, listarAdmin, obtenerAdmin, cambiarEstado, expirarPendientes, calcularEnvio };
