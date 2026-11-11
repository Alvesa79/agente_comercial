// Rutas del webhook de WhatsApp Cloud API (Meta).
// - GET: verificación del endpoint (hub.mode / hub.verify_token / hub.challenge)
// - POST: mensajes entrantes; se valida la firma X-Hub-Signature-256

import crypto from 'node:crypto';
import { Router } from 'express';
import { config, whatsappConfigured } from './config.js';
import { handleIncomingMessage } from './agent.js';
import { sendWhatsAppMessage, markAsRead } from './whatsapp-send.js';
import { claimMessage } from './store.js';

const router = Router();

function verifySignature(req) {
  if (!whatsappConfigured()) return true; // en pruebas locales sin secret configurado
  const header = req.get('X-Hub-Signature-256') || '';
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', config.whatsapp.appSecret).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

function extractMessage(body) {
  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    if (value?.messages?.length) {
      const msg = value.messages[0];
      if (msg.type === 'text') {
        return {
          from: msg.from, // número del cliente en formato internacional
          text: msg.text.body,
          waMessageId: msg.id,
        };
      }
    }
  } catch {
    // estructura inesperada: se ignora y se responde 200 para evitar reintentos infinitos de Meta
  }
  return null;
}

router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

router.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) {
    console.warn('[webhook] Firma inválida, mensaje descartado');
    return res.sendStatus(401);
  }

  // Respondemos 200 a Meta inmediatamente y procesamos en segundo plano
  // para no recibir timeouts y reintentos.
  res.sendStatus(200);

  const message = extractMessage(req.body);
  if (!message) return;

  // Meta reintenta la entrega si tarda o falla: procesamos cada mensaje una sola vez.
  if (!claimMessage(message.waMessageId)) {
    console.log(`[webhook] Entrega duplicada ignorada: ${message.waMessageId}`);
    return;
  }
  console.log(`[webhook] Mensaje entrante de ${message.from}`);

  void markAsRead(message.waMessageId).catch(() => {});

  try {
    const { leadId, handoff, createError, queued, reply } = await handleIncomingMessage(
      message.from,
      message.text,
      { waMessageId: message.waMessageId }
    );
    // El mensaje final (lead, handoff o error) tiene prioridad; si no, se envía
    // el del paso actual de la conversación.
    const text = buildReply(leadId, handoff, createError, queued) || reply;
    if (text) {
      await sendWhatsAppMessage(message.from, text);
    }
    if (leadId) {
      console.log(`[webhook] Lead creado en Odoo: id=${leadId} para ${message.from}`);
    } else if (queued) {
      console.log(`[webhook] Lead encolado para reintento: ${message.from}`);
    }
  } catch (err) {
    console.error('[webhook] Error procesando el mensaje:', err.message);
    try {
      await sendWhatsAppMessage(
        message.from,
        'Disculpa, tuvimos un problema temporal. Un asesor te escribirá pronto. 🙏'
      );
    } catch {
      // Si tampoco podemos avisar, Meta reintenta el envío por su cuenta hasta agotar.
    }
  }
});

function buildReply(leadId, handoff, createError, queued) {
  if (handoff) {
    return 'Con gusto, en un momento un asesor humano continuará la conversación. 🙌';
  }
  if (queued) {
    return 'Gracias por tu información. 🙏 Tu solicitud quedó registrada y la estamos procesando; un asesor te contactará pronto.';
  }
  if (createError) {
    return 'Gracias por tu información. 🙏 No pudimos registrar tu solicitud automáticamente; un asesor te contactará pronto.';
  }
  if (leadId) {
    return `¡Gracias! ✅ Tu solicitud quedó registrada (folio #${leadId}). Un asesor te contactará a la brevedad.`;
  }
  return null; // pasos intermedios: se usa el mensaje que devuelve el agente
}

export default router;
