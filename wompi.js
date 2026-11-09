'use strict';
/* Integración con Wompi (Colombia). Basada en la documentación pública de Wompi:
   - Web Checkout con firma de integridad: SHA-256( referencia + montoEnCentavos + moneda + secretoIntegridad )
   - Eventos (webhook): checksum = SHA-256( valores de signature.properties + timestamp + secretoEventos )
   - Consulta de transacción: GET {api}/transactions/{id}
   Verifica estos detalles contra https://docs.wompi.co antes de salir a producción. */
const crypto = require('node:crypto');
const cfg = require('./config');
const { safeEqualStr } = { safeEqualStr: (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); } };

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const referencia = (codigo, intento) => `${codigo}-${intento}`;
const codigoDeReferencia = ref => String(ref || '').replace(/-\d+$/, '');

function checkoutUrl(order, intento) {
  const ref = referencia(order.codigo, intento), cents = order.total * 100;
  const retorno = `${cfg.baseUrl}/pago/retorno?codigo=${encodeURIComponent(order.codigo)}&t=${encodeURIComponent(order.token)}`;
  const q = {
    'public-key': cfg.wompi.public, currency: 'COP', 'amount-in-cents': String(cents), reference: ref,
    'signature:integrity': sha256(`${ref}${cents}COP${cfg.wompi.integrity}`),
    'redirect-url': retorno, 'customer-data:email': order.correo, 'customer-data:full-name': order.nombre
  };
  return 'https://checkout.wompi.co/p/?' + Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/** Valida que el evento realmente venga de Wompi (checksum con el secreto de eventos). */
function verificarEvento(body, headerChecksum) {
  try {
    const props = body?.signature?.properties, sum = body?.signature?.checksum || headerChecksum;
    if (!Array.isArray(props) || !sum || body.timestamp === undefined) return false;
    const vals = props.map(p => String(p).split('.').reduce((o, k) => o?.[k], body.data));
    if (vals.some(v => v === undefined || v === null)) return false;
    const expected = sha256(vals.join('') + String(body.timestamp) + cfg.wompi.events);
    return safeEqualStr(expected, String(sum).toLowerCase());
  } catch { return false; }
}

/** Consulta la transacción directamente a Wompi (fuente confiable, no los parámetros de la URL). */
async function consultarTransaccion(id) {
  const r = await fetch(`${cfg.wompi.apiBase}/transactions/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Wompi respondió ${r.status}`);
  const j = await r.json();
  return j.data;
}

module.exports = { checkoutUrl, verificarEvento, consultarTransaccion, referencia, codigoDeReferencia };
