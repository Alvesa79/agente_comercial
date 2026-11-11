// Configuración central leída de variables de entorno.
//
// Carga .env sin dependencias externas. No sobreescribe variables que ya existan
// en el entorno y se omite durante `npm test` para no depender de credenciales reales.

import fs from 'node:fs';
import path from 'node:path';

function loadEnvFile(file = path.resolve(process.cwd(), '.env')) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return; // sin .env: se usan solo las variables del entorno
  }
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    const quoted =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"));
    process.env[key] = quoted ? rawValue.slice(1, -1) : rawValue.replace(/\s+#.*$/, '');
  }
}

if (!process.env.NODE_TEST_CONTEXT) loadEnvFile();

function required(name, fallback = null) {
  const value = process.env[name] || fallback;
  if (!value) {
    // No lanzamos error al importar: el servicio arranca y degrada de forma controlada.
    console.warn(`[config] Falta la variable de entorno ${name}`);
    return null;
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT || 3000),

  whatsapp: {
    appSecret: required('WHATSAPP_APP_SECRET'),
    verifyToken: required('WHATSAPP_VERIFY_TOKEN'),
    token: required('WHATSAPP_TOKEN'),
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || null,
  },

  odoo: {
    url: (required('ODOO_URL') || '').replace(/\/+$/, ''),
    db: required('ODOO_DB'),
    email: required('ODOO_EMAIL'),
    apiKey: required('ODOO_API_KEY'),
    // Equipo de ventas cuyo líder recibe los leads de contactos nuevos.
    teamId: process.env.ODOO_TEAM_ID ? Number(process.env.ODOO_TEAM_ID) : null,
  },

  llm: {
    baseUrl: (process.env.LLM_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.LLM_API_KEY || null,
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
  },
};

export function odooConfigured() {
  const { url, db, email, apiKey } = config.odoo;
  return Boolean(url && db && email && apiKey);
}

export function whatsappConfigured() {
  return Boolean(config.whatsapp.appSecret && config.whatsapp.token);
}

export function llmConfigured() {
  return Boolean(config.llm.baseUrl && config.llm.apiKey);
}
