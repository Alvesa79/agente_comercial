# Agente Comercial WhatsApp → Odoo CRM

Servicio que recibe solicitudes por WhatsApp vía la **WhatsApp Cloud API de Meta**,
conversa con el cliente para calificarlo y **crea leads en Odoo Enterprise** (módulo CRM)
automáticamente mediante JSON-RPC.

## ¿Cómo funciona?

```
Cliente WhatsApp
      │  mensaje
      ▼
Meta WhatsApp Cloud API ──webhook──▶ Este servicio (Express)
                                       │
                                       ├─ Sesión de conversación (nombre, necesidad, presupuesto, ubicación)
                                       ├─ Clasificación (LLM opcional o reglas)
                                       └─ Deduplica el contacto por teléfono
                                                   │
                                                   ▼
                                        Odoo CRM → crm.lead creado
```

1. El cliente envía un mensaje de WhatsApp.
2. Meta hace POST al webhook `/webhook` (firma validada con `X-Hub-Signature-256`).
3. El agente pregunta: nombre → necesidad → presupuesto → ubicación.
4. Al finalizar, creará un `crm.lead` en Odoo con toda la información,
   etiquetas (`WhatsApp` + categoría) y la descripción resumida.
5. El cliente recibe confirmación con el folio del lead.
6. Si el cliente pide un "asesor/persona", se hace handoff (se detiene el flujo
   y queda en manos del equipo comercial).

Si el teléfono ya existe como contacto (`res.partner`), el lead se vincula a él.

## Estructura

```
src/
  index.js          Servidor Express + /health
  config.js         Variables de entorno + carga de .env (degrada de forma controlada si falta algo)
  webhook.js        GET (verificación de Meta) y POST (mensajes entrantes)
  agent.js          Máquina de estados, asignación y cola de reintento de leads
  odoo.js           Cliente JSON-RPC: login, dedupe, asignación, crear crm.lead
  store.js          Persistencia de sesiones, idempotencia y cola de leads
  whatsapp-send.js  Envío de respuestas y marcado de lectura (Graph API v19.0)
  llm.js            Clasificador opcional compatible con OpenAI
test/               Tests con node:test (mocks de fetch para Odoo)
```

## Puesta en marcha

```bash
npm install
cp .env.example .env    # completa tus credenciales
npm start               # http://localhost:3000
```

El archivo `.env` se carga automáticamente al arrancar (sin dependencias extra);
las variables ya definidas en el entorno tienen prioridad. El servicio arranca
incluso sin credenciales (modo prueba local) y `/health` indica qué está configurado.

### 1. Meta (WhatsApp Cloud API)

1. Crea una app de tipo *Business* en [developers.facebook.com](https://developers.facebook.com).
2. En WhatsApp → Configuration, copia el **App secret** (`WHATSAPP_APP_SECRET`)
   y genera un token permanente o de sistema (`WHATSAPP_TOKEN`).
3. Elige un token de verificación propio (`WHATSAPP_VERIFY_TOKEN`).
4. En el webhook apunta a `https://TU-DOMINIO/webhook` y usa ese token:
   Meta hará un GET con `hub.challenge`.
5. Suscríbete al campo **messages**.
6. Los mensajes entrantes activan el flujo. Antes de usar WhatsApp Cloud
   en producción, el propio número de negocio necesita estar verificado.

### 2. Odoo (Enterprise)

En Odoo: Preferencias del usuario → Seguridad → **API Keys** para generar
la clave (`ODOO_API_KEY`). Requiere permisos de *Sales/Administrator* para
crear leads.

```
ODOO_URL=https://tudominio.odoo.com
ODOO_DB=tudominio
ODOO_EMAIL=tucorreo@empresa.com
ODOO_API_KEY=tu-api-key
```

### 3. LLM (opcional)

Sin LLM se usa una clasificación por reglas y extrae igual el texto.
Si quieres que la clasificación de la necesidad sea más inteligente, define:

```
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
```

Cualquier endpoint compatible con OpenAI funciona (Azure, OpenRouter, Ollama...).

## Desarrollo

```bash
npm run dev     # recarga automática
npm test        # suite de pruebas
```

## Asignación del lead

1. Si el teléfono ya existe en `res.partner` y tiene **Salesperson** (`user_id`),
   el lead se asigna a ese vendedor y se le notifica en Odoo (actividad de llamada
   + mensaje en el chatter).
2. Si el contacto no existe o no tiene vendedor, el lead va al **Team Leader**
   del equipo configurado en `ODOO_TEAM_ID` (o el primer equipo con líder).
3. Si el cliente pide un asesor humano, se crea el lead con los datos disponibles
   y se aplica la misma regla, para que nadie pierda la solicitud.

## Notas de producción

- **Sesiones persistentes**: se guardan en `STATE_FILE` (`.data/state.json` por
  defecto) y sobreviven reinicios. Para varias instancias, sustituye `src/store.js`
  por un adaptador de Redis/Postgres.
- **Idempotencia**: cada `waMessageId` se procesa una sola vez durante 24 h, aunque
  Meta reintente la entrega.
- **Cola de leads**: si Odoo no responde, el lead se encola y se reintenta cada
  `OUTBOX_INTERVAL_MS` con backoff; no se pierde la solicitud.
- **Persistencia del webhook**: Meta reintenta si no respondes 200 en segundos; ya
  se responde 200 antes de procesar.
- **Deduplicación**: se compara por teléfono (últimos 10 dígitos de `res.partner.phone`; en Odoo ≤18 también `mobile`).
- **Handoff**: al pedir un humano se crea/asigna el lead y el flujo se pausa.
- **Auditoría**: los logs muestran el id del lead creado y a quién se asignó.
- **Permisos**: usa un usuario de Odoo con permisos solo de CRM/Ventas, no Administrator.
