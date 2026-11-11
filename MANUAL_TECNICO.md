# Manual Técnico: Agente Comercial WhatsApp + Odoo CRM

**Versión:** 1.0  
**Stack Tecnológico:** Node.js (ES Modules), Express, Meta WhatsApp Cloud API (Graph v19.0+), Odoo JSON-RPC API, Render PaaS.

---

## 1. Arquitectura del Sistema

El agente actúa como un **Middleware reactivo y de alta disponibilidad** entre la plataforma de mensajería de Meta (WhatsApp Business Cloud) y la base de datos de Odoo Enterprise/Community (CRM).

```
   ┌────────────────────────────────────────────────────────┐
   │                   USUARIO FINAL                        │
   │               (App WhatsApp en Móvil)                 │
   └──────────────────────────┬─────────────────────────────┘
                              │ Mensajes / Webhook
                              ▼
   ┌────────────────────────────────────────────────────────┐
   │                  META CLOUD API                        │
   │             (Graph API / Webhook Engine)               │
   └──────────────────────────┬─────────────────────────────┘
                              │ HTTPS POST (Firma HMAC-SHA256)
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                   SERVICIO AGENTE (Render PaaS)                  │
│                                                                  │
│  [src/index.js] ──────────── Servidor Express / Rutas            │
│       │                                                          │
│       ├── GET  /health ───── Verificación de estado              │
│       ├── GET  /webhook ──── Verificación de reto de Meta        │
│       └── POST /webhook ──── Recepción de eventos                │
│                                                                  │
│  [src/webhook.js] ────────── Validación Firma & Deduplicación    │
│       │                      (claimMessage / HMAC verify)        │
│       ▼                                                          │
│  [src/agent.js] ──────────── Máquina de Estados de Conversación  │
│       │                      (START -> NAME -> NEED -> BUDGET    │
│       │                       -> LOCATION -> DONE / HANDOFF)     │
│       │                                                          │
│       ├── [src/store.js] ─── Persistencia Atómica (state.json)    │
│       │                      (Sesiones, Idempotencia, Outbox)    │
│       │                                                          │
│       └── [src/llm.js] ───── Clasificador OpenAI (Opcional)      │
└─────────────────────────────┬────────────────────────────────────┘
                              │ Llamadas JSON-RPC (/jsonrpc)
                              ▼
   ┌────────────────────────────────────────────────────────┐
   │                   ODOO ERP / CRM                       │
   │      (res.partner, crm.lead, crm.team, mail.activity)  │
   └────────────────────────────────────────────────────────┘
```

---

## 2. Componentes y Módulos de Código

| Archivo | Responsabilidad Principal |
|---|---|
| `src/index.js` | Inicializa el servidor Express en `0.0.0.0`, expone `/`, `/health`, monta el webhook y activa el temporizador periódico para procesar la cola Outbox. |
| `src/config.js` | Carga y valida variables de entorno. Normaliza URLs (remueve `/odoo` y barras finales) y provee funciones detectoras (`whatsappConfigured()`, `odooConfigured()`, etc.). |
| `src/webhook.js` | Endpoint de Meta. Valida firma `X-Hub-Signature-256`, responde `200 OK` inmediato para evitar timeouts, descarta duplicados y gestiona respuestas hacia WhatsApp. |
| `src/agent.js` | Motor de conversación y máquina de estados. Gestiona los pasos del diálogo, detección de comandos (`cancelar`, `asesor`), y coordina la creación del lead. |
| `src/odoo.js` | Cliente JSON-RPC contra Odoo. Implementa autenticación (`common/login`), búsqueda de partners (`res.partner`), equipos (`crm.team`), creación de leads (`crm.lead`) y asignación de actividades (`mail.activity`). |
| `src/store.js` | Gestor de persistencia atómica en disco (`.data/state.json`). Maneja sesiones con TTL (30 min), deduplicación de entregas (24 h) y cola Outbox de reintentos. |
| `src/whatsapp-send.js` | Cliente HTTP hacia Meta Graph API (`/messages`). Envía respuestas de texto y marca mensajes entrantes como leídos (`status: read`). |
| `src/llm.js` | Adaptador para modelos compatibles con OpenAI (`/v1/chat/completions`) para extracción estructurada de necesidades y categorías. |

---

## 3. Seguridad y Resiliencia

### 3.1 Verificación Criptográfica (HMAC-SHA256)
Cada petición entrante de Meta incluye el encabezado `X-Hub-Signature-256`. El servidor computa el digest HMAC usando el buffer crudo (`req.rawBody`) y la clave secreta `WHATSAPP_APP_SECRET`:
```javascript
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
```
Las peticiones con firma inválida son rechazadas inmediatamente con código `401 Unauthorized`.

### 3.2 Deduplicación e Idempotencia
Meta reintenta la entrega de un webhook si experimenta latencia de red. Para evitar procesar dos veces el mismo mensaje o crear leads duplicados, `claimMessage(waMessageId)` almacena los identificadores procesados durante 24 horas.

### 3.3 Patrón Outbox (Tolerancia a Caídas de Odoo)
Si la base de datos de Odoo no está disponible o se encuentra en ventana de mantenimiento:
1. El agente almacena el lead en la cola `outbox` dentro del estado persistente.
2. Informa al cliente que su solicitud fue recibida.
3. Un proceso en segundo plano reintenta cada `OUTBOX_INTERVAL_MS` (por defecto 60 segundos) vaciar la cola una vez restablecida la conexión con Odoo.

---

## 4. Referencia de Variables de Entorno

```env
# ==== Servidor ====
PORT=3000                        # Puerto asignado (en Render se inyecta dinámicamente)

# ==== Meta WhatsApp Cloud API ====
WHATSAPP_APP_SECRET=             # Secreto de la App en developers.facebook.com
WHATSAPP_VERIFY_TOKEN=           # Token arbitrario para validar la suscripción del webhook
WHATSAPP_TOKEN=                  # Token de acceso (System User Token para producción)
WHATSAPP_PHONE_NUMBER_ID=        # ID numérico del número de teléfono en Meta

# ==== Odoo ERP (JSON-RPC) ====
ODOO_URL=                        # URL base (ej. https://miempresa.odoo.com)
ODOO_DB=                         # Nombre exacto de la base de datos
ODOO_EMAIL=                      # Correo del usuario de integración
ODOO_API_KEY=                    # API Key o contraseña del usuario
ODOO_TEAM_ID=                    # (Opcional) ID numérico de crm.team a asignar

# ==== Persistencia ====
STATE_FILE=.data/state.json      # Ruta al archivo JSON de estado
OUTBOX_INTERVAL_MS=60000         # Intervalo en milisegundos para reintentos

# ==== IA / LLM (Opcional) ====
LLM_BASE_URL=                    # Endpoint compatible OpenAI (ej. https://api.openai.com/v1)
LLM_API_KEY=                     # Clave de API de OpenAI / OpenRouter
LLM_MODEL=gpt-4o-mini            # Modelo a utilizar
```

---

## 5. Pruebas y Diagnóstico

### Ejecución de Pruebas Unitarias
El proyecto utiliza el test runner nativo de Node.js (`node --test`), ejecutando mocks completos de Odoo y Meta:
```bash
npm test
```

### Endpoints de Monitoreo
* **Health Check**: `GET /health`  
  Devuelve el estado de conexión de cada subsistema:
  ```json
  {
    "status": "ok",
    "whatsapp": "configurado",
    "odoo": "configurado",
    "llm": "modo reglas"
  }
  ```

---

## 6. Procedimiento de Despliegue en Render

1. El repositorio incluye un Blueprint declarativo en [`render.yaml`](file:///c:/freebuff/Agente%20Comercial/render.yaml).
2. Render compila con `npm install --omit=dev` y arranca con `npm start`.
3. Para producción garantizada con persistencia, se recomienda el plan **Starter** con un disco persistente de 1 GB montado en `/data` y `STATE_FILE=/data/state.json`.
