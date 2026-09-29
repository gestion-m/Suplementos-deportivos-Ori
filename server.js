// ORI Suplementos — backend de cobros con Mercado Pago (Checkout Pro)
// Los secretos viven SOLO acá (variables de entorno), nunca en la página.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const {
  MP_ACCESS_TOKEN,
  SITE_URL,               // URL completa de la tienda
  BACKEND_URL,            // URL pública de este servidor en Render
  TELEGRAM_BOT_TOKEN,     // token que da @BotFather
  TELEGRAM_CHAT_ID,       // tu ID de Telegram
  FIREBASE_SERVICE_ACCOUNT, // contenido completo del .json de la clave de servicio
  PORT = 3000,
} = process.env;

if (!MP_ACCESS_TOKEN || !SITE_URL || !BACKEND_URL) {
  console.error('Faltan variables: MP_ACCESS_TOKEN, SITE_URL, BACKEND_URL');
  process.exit(1);
}

// Firebase (opcional: si falta la clave, el servidor sigue cobrando pero no marca pedidos)
let db = null;
try {
  if (FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
    db = admin.firestore();
  } else {
    console.warn('AVISO: falta FIREBASE_SERVICE_ACCOUNT, los pedidos no se marcan solos.');
  }
} catch (e) {
  console.error('Firebase no pudo iniciar:', e.message);
}

async function avisarTelegram(texto) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: texto }),
    });
    if (!r.ok) console.error('telegram:', r.status, await r.text());
  } catch (e) {
    console.error('telegram:', e.message);
  }
}

const mp = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const app = express();
app.use(express.json());
app.use(cors({ origin: new URL(SITE_URL).origin })); // solo el origen de tu tienda

app.get('/health', (_req, res) => res.send('ok'));

// 1) La tienda manda el carrito y recibe el link de pago
app.post('/crear-pago', async (req, res) => {
  try {
    const { items, comprador, referencia } = req.body || {};
    if (!Array.isArray(items) || !items.length || items.length > 50) {
      return res.status(400).json({ error: 'Carrito inválido' });
    }
    const cleanItems = items.map((i) => {
      const quantity = Math.floor(Number(i.quantity));
      const unit_price = Number(i.unit_price);
      if (!i.title || !(quantity > 0) || !(unit_price > 0)) throw new Error('Item inválido');
      return {
        id: String(i.id || i.title).slice(0, 60),
        title: String(i.title).slice(0, 120),
        quantity,
        unit_price, // PRECIO CON TARJETA / MP (ya incluye la comisión)
        currency_id: 'ARS',
      };
    });
    // La página manda el número de pedido: se usa como referencia para poder marcarlo después
    const externalRef = /^\d{1,10}$/.test(String(referencia || '')) ? String(referencia) : 'W' + Date.now();
    const site = SITE_URL.replace(/\/$/, '');
    const pref = await new Preference(mp).create({
      body: {
        items: cleanItems,
        payer: comprador?.email ? { email: comprador.email, name: comprador.nombre } : undefined,
        external_reference: externalRef,
        back_urls: {
          success: `${site}/?pago=ok`,
          pending: `${site}/?pago=pendiente`,
          failure: `${site}/?pago=error`,
        },
        auto_return: 'approved',
        notification_url: `${BACKEND_URL.replace(/\/$/, '')}/webhook`,
        statement_descriptor: 'ORI SUPLEMENTOS',
      },
    });
    res.json({ init_point: pref.init_point, id: pref.id, referencia: externalRef });
  } catch (e) {
    console.error('crear-pago:', e.message);
    res.status(500).json({ error: 'No se pudo crear el pago' });
  }
});

// 2) Mercado Pago avisa acá cuando cambia el estado de un pago
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responder rápido siempre
  try {
    const paymentId = req.body?.data?.id || req.query['data.id'];
    const type = req.body?.type || req.query.type;
    if (type !== 'payment' || !paymentId) return;

    // Verificamos consultando a Mercado Pago (no confiamos en el body recibido)
    const pago = await new Payment(mp).get({ id: paymentId });
    const estado = pago.status; // approved | pending | rejected | cancelled ...
    const ref = String(pago.external_reference || '');
    console.log('PAGO', { id: pago.id, estado, referencia: ref, monto: pago.transaction_amount });
    if (!/^\d{1,10}$/.test(ref)) return; // no es un pedido de la tienda

    let yaAprobado = false;
    if (db) {
      const docRef = db.collection('pagos').doc(ref);
      const previo = await docRef.get();
      yaAprobado = previo.exists && previo.data().estado === 'approved';
      if (!yaAprobado) {
        await docRef.set({
          estado,
          monto: pago.transaction_amount,
          mpPaymentId: String(pago.id),
          actualizado: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }

    // Aviso por Telegram solo la primera vez que se aprueba
    if (estado === 'approved' && !yaAprobado) {
      const lista = (pago.additional_info?.items || [])
        .map((i) => `• ${i.quantity} x ${i.title}`).join('\n');
      const monto = Number(pago.transaction_amount).toLocaleString('es-AR');
      await avisarTelegram(`✅ Pago aprobado\nPedido #${ref}\nTotal: $${monto}\n${lista}\n\nAbrí la app en modo edición para confirmarlo y despachar.`);
    }
  } catch (e) {
    console.error('webhook:', e.message);
  }
});

app.listen(PORT, () => console.log('ORI pagos escuchando en', PORT));
