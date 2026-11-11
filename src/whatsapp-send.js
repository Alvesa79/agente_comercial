// Envío de mensajes y marcado de lectura mediante la Graph API de WhatsApp Cloud.

import { config, whatsappConfigured } from './config.js';

const GRAPH_URL = 'https://graph.facebook.com/v19.0';

export async function sendWhatsAppMessage(to, text) {
  if (!whatsappConfigured()) {
    console.warn('[send] WHATSAPP_TOKEN/APP_SECRET no configurados: no se envía el mensaje real.');
    return null;
  }
  const id = config.whatsapp.phoneNumberId;
  if (!id) {
    console.warn('[send] WHATSAPP_PHONE_NUMBER_ID no configurado: no se envía el mensaje real.');
    return null;
  }
  const res = await fetch(`${GRAPH_URL}/${id}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.whatsapp.token}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: text },
    }),
  });
  if (!res.ok) {
    throw new Error(`WhatsApp send HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export async function markAsRead(waMessageId) {
  if (!whatsappConfigured() || !config.whatsapp.phoneNumberId || !waMessageId) {
    return null;
  }
  const res = await fetch(`${GRAPH_URL}/${config.whatsapp.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.whatsapp.token}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: waMessageId,
    }),
  });
  if (!res.ok) throw new Error(`WhatsApp read HTTP ${res.status}`);
  return res.json();
}
