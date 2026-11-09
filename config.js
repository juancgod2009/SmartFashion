'use strict';
/* Configuración desde variables de entorno (y archivo .env si existe). Nunca pongas claves en el código. */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* .env es opcional */ }

const e = process.env;
const port = Number(e.PORT) || 3000;
const wompi = { public: e.WOMPI_PUBLIC_KEY || '', integrity: e.WOMPI_INTEGRITY_SECRET || '', events: e.WOMPI_EVENTS_SECRET || '' };
wompi.enabled = Boolean(wompi.public && wompi.integrity && wompi.events);
wompi.sandbox = wompi.public.startsWith('pub_test_');
wompi.apiBase = wompi.sandbox ? 'https://sandbox.wompi.co/v1' : 'https://production.wompi.co/v1';

module.exports = {
  root, port, wompi,
  host: e.HOST || '0.0.0.0',
  prod: e.NODE_ENV === 'production',
  dataDir: path.resolve(e.DATA_DIR || path.join(root, 'data')),
  baseUrl: (e.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  trustProxy: e.TRUST_PROXY === '1',
  seedDemo: e.SEED_DEMO !== 'false',
  reservaHoras: Number(e.RESERVA_HORAS) || 24,
  adminEmail: (e.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminPassword: e.ADMIN_PASSWORD || ''
};
