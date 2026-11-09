# SmartFashion · Fase 2 (tienda real)

Tienda virtual con catálogo, carrito, pedidos, pago en línea con **Wompi**, seguimiento de pedidos y **panel administrativo**.
Sin dependencias: solo necesita **Node.js 22.13 o superior** (`node --version`). Los datos van en SQLite.

> La Fase 1 era solo HTML/JS y se podía publicar en GitHub Pages. **Esta fase tiene servidor, así que GitHub Pages ya no sirve**: necesita un hosting que ejecute Node.js (ver «Publicar»).

## 1. Probar en tu computador
```bash
npm run crear-admin     # crea tu cuenta administradora (contraseña de 12+ caracteres)
npm start               # abre http://localhost:3000   ·   panel: http://localhost:3000/admin
npm test                # 15 pruebas automáticas del backend
```
La primera vez, si la base está vacía, se cargan 8 productos de ejemplo (`SEED_DEMO=false` para empezar vacío). Edítalos o elimínalos desde el panel.

## 2. Configurar la tienda (panel `/admin`)
1. **Contenido y envío**: tarifa de envío real, envío gratis desde, correo/teléfono/WhatsApp/redes, instrucciones de pago por transferencia, banner de portada, guía de tallas (revisa que sean tus medidas) y textos legales.
2. **Productos**: crea productos con fotos (JPG/PNG/WEBP, máx. 5 MB), precio, precio anterior (solo si hay descuento real), colores, tallas e **inventario por variante**. «Eliminar» archiva el producto si ya tiene pedidos.
3. **Pedidos**: ves cada pedido y cambias su estado. Cancelar devuelve el inventario.
4. **Mensajes**: lo que escriben desde «Contacto».

## 3. Pagos
| Método | Cuándo aparece | Cómo se confirma |
|---|---|---|
| **Wompi** (tarjeta, PSE, Nequi…) | Si hay claves de Wompi **y** tarifa de envío configurada | Solo por confirmación de Wompi (webhook firmado + consulta directa a su API). Nadie, ni el administrador, puede marcarlo «Pagado» a mano. |
| **Transferencia / acuerdo** | Siempre | El pedido queda «Pendiente de pago»; tú lo pasas a «Pagado» cuando verificas el dinero. |

### Activar Wompi
1. Crea tu cuenta en <https://wompi.co> y entra al panel de comercios (primero en **modo Sandbox/pruebas**).
2. En *Desarrolladores* copia: llave pública (`pub_test_…`), secreto de **integridad** y secreto de **eventos**.
3. Ponlos en las variables `WOMPI_PUBLIC_KEY`, `WOMPI_INTEGRITY_SECRET`, `WOMPI_EVENTS_SECRET` (ver `.env.example`) y reinicia.
4. En Wompi configura la **URL de eventos**: `https://TU-DOMINIO/api/wompi/webhook` (debe ser https público; en tu PC no funciona sin un túnel).
5. Haz un pedido de prueba con las tarjetas/cuentas de prueba que indica la documentación de Wompi. Verás el estado cambiar a «Pagado» solo.
6. Para vender de verdad: completa la activación de tu comercio en Wompi, cambia a las llaves de **producción** (`pub_prod_…`).

> Este código se escribió siguiendo la documentación pública de Wompi (firma de integridad, checksum de eventos y consulta de transacciones), pero **no pude probarlo contra Wompi desde mi entorno**. Haz la prueba en Sandbox y revisa <https://docs.wompi.co> antes de cobrar dinero real. Los reembolsos se hacen desde el panel de Wompi.

## 4. Publicar en internet (para obtener la URL)
Necesitas un servicio que ejecute Node.js 22 **con disco persistente** (la base de datos y las fotos son archivos). Sin disco persistente, los datos se pierden en cada despliegue.

**Opción rápida para mostrarla hoy (gratis, temporal):** con la tienda corriendo en tu PC, usa un túnel, por ejemplo `cloudflared tunnel --url http://localhost:3000` (Cloudflare) o `ngrok http 3000`. Te dan una URL https pública mientras tu computador esté encendido. Sirve para presentar el proyecto, no para vender.

**Opción permanente (ej. Render):**
1. Sube esta carpeta a un repositorio de GitHub (el `.gitignore` ya excluye `.env` y `data/`).
2. En <https://render.com> → *New → Web Service* → conecta el repositorio → *Runtime: Docker* (usa el `Dockerfile`).
3. Agrega un **Disk** montado en `/data` (requiere plan de pago; verifica el precio actual) o usa el `render.yaml` incluido (*New → Blueprint*).
4. Variables de entorno: `BASE_URL` (la URL que te asigne Render, con https), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (12+ caracteres, para crear tu cuenta en el primer arranque; **bórrala después**), y las de Wompi.
5. Abre la URL que te da Render. Panel en `/admin`. Si luego compras un dominio propio, cámbialo en el hosting y actualiza `BASE_URL` y la URL de eventos en Wompi.

Otras opciones equivalentes: Railway o Fly.io (con volumen), o un VPS/hosting con Node.js 22 (por ejemplo Hostinger VPS): `npm start` detrás de un proxy https (Caddy/Nginx) y `TRUST_PROXY=1`. Verifica que tu plan soporte Node 22.13+.

**Copias de seguridad:** copia periódicamente la carpeta `DATA_DIR` (contiene `smartfashion.db` y `uploads/`).

## 5. Seguridad implementada
- Contraseñas con **scrypt** + sal; sesiones en cookie `HttpOnly`, `SameSite=Strict` y `Secure` en producción; token **CSRF** y verificación de `Origin`; límite de intentos en login, pedidos y contacto.
- Todas las rutas `/api/admin/*` comprueban sesión en el servidor. Los precios, descuentos, envío e inventario **se recalculan en el servidor** al crear cada pedido; el navegador solo los muestra.
- El inventario se descuenta de forma atómica (no hay inventario negativo ni ventas dobles). Pedidos con pago en línea sin pagar liberan el inventario a las `RESERVA_HORAS`.
- Subida de imágenes: se valida el contenido real (JPG/PNG/WEBP), máx. 5 MB, nombre aleatorio; SVG no se acepta.
- Cabeceras de seguridad (CSP, nosniff, frame-ancestors…). Sin claves en el código; todo por variables de entorno. No se guardan datos de tarjetas: el pago ocurre en Wompi.
- Consulta de pedidos solo con código + correo, o con el enlace privado que recibe la compradora.

## 6. Lo que todavía NO hace (decisiones tuyas o fases futuras)
- **No envía correos** (confirmación de pedido, cambio de estado). Requiere un servicio SMTP/API de correo; por ahora ves los pedidos en el panel y contactas a la clienta.
- No calcula tarifas por ciudad ni conecta transportadoras: hay una tarifa única y envío gratis opcional.
- No emite factura electrónica ni calcula impuestos. Consulta con un contador qué te corresponde.
- **Textos legales** (privacidad/habeas data, términos, devoluciones): debes redactarlos (idealmente con asesoría) y pegarlos en el panel. No se inventaron.
- Una sola tienda/instancia (SQLite). Si crece mucho, se migra a PostgreSQL.

## 7. Estructura
```
server.js          rutas HTTP, seguridad, archivos estáticos
lib/               db.js (esquema), products.js, orders.js, wompi.js, auth.js, util.js, config.js
public/            tienda (index.html, js/app.js, js/store.js, css/styles.css) y panel (admin.html, js/admin.js)
scripts/           crear-admin.js, test.js
```
Colores y fuentes: bloque `:root` de `public/css/styles.css`. Logo: comentario en `public/index.html`.
