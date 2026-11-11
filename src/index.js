// Punto de entrada del servicio.

import express from 'express';
import { config, odooConfigured, whatsappConfigured, llmConfigured } from './config.js';
import webhookRouter from './webhook.js';
import { processOutbox } from './agent.js';

const OUTBOX_INTERVAL_MS = Number(process.env.OUTBOX_INTERVAL_MS || 60 * 1000);

const app = express();

// Guardamos el cuerpo crudo para verificar la firma de Meta (X-Hub-Signature-256).
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
  limit: '1mb',
}));

app.get('/', (_req, res) => {
  res.redirect('/health');
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    whatsapp: whatsappConfigured() ? 'configurado' : 'sin credenciales (modo prueba local)',
    odoo: odooConfigured() ? 'configurado' : 'sin credenciales (modo prueba local)',
    llm: llmConfigured() ? 'activado' : 'modo reglas',
  });
});

app.use('/', webhookRouter);

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[index] Agente comercial escuchando en el puerto ${config.port}`);
  console.log(`[index] WhatsApp: ${whatsappConfigured() ? 'OK' : 'FALTA CONFIGURAR'}`);
  console.log(`[index] Odoo:     ${odooConfigured() ? 'OK' : 'FALTA CONFIGURAR'}`);
  console.log(`[index] LLM:      ${llmConfigured() ? 'OK' : 'desactivado (usa reglas)'}`);
});

// Reintenta leads que no pudieron crearse porque Odoo estaba caído.
setInterval(() => {
  processOutbox().catch((err) => console.error('[outbox] Error inesperado:', err.message));
}, OUTBOX_INTERVAL_MS).unref();

export default server;
