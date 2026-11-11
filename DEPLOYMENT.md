# Despliegue en producción: Odoo.sh + host externo

Guía para llevar el agente comercial de WhatsApp a producción contra una base real
de Odoo.sh, con asignación de leads a vendedores.

> Contenido relacionado: `README.md` (arquitectura y puesta en marcha local),
> `.env.example` (todas las variables) y `Dockerfile` (imagen del servicio).

---

## Índice

1. [Arquitectura y regla de oro](#1-arquitectura-y-regla-de-oro)
2. [Preparar Odoo.sh](#2-preparar-odoo-sh)
3. [Elegir el host externo](#3-elegir-el-host-externo)
   - [Despliegue en Render (paso a paso)](#31-despliegue-en-render-paso-a-paso)
4. [Despliegue en un VPS (paso a paso)](#4-despliegue-en-un-vps-paso-a-paso)
5. [HTTPS con Caddy](#5-https-con-caddy)
6. [Alternativa sin Docker (systemd)](#6-alternativa-sin-docker-systemd)
7. [Configurar Meta](#7-configurar-meta)
8. [Variables de entorno](#8-variables-de-entorno)
9. [Validación extremo a extremo](#9-validación-extremo-a-extremo)
10. [Operación, backups y actualizaciones](#10-operación-backups-y-actualizaciones)
11. [Problemas típicos](#11-problemas-típicos)
12. [Advertencias técnicas](#12-advertencias-técnicas)

---

## 1. Arquitectura y regla de oro

Odoo.sh **solo aloja Odoo** (Python, PostgreSQL y sus workers). No ejecuta daemons
de Node, no instala paquetes del sistema y no mantiene conexiones largas. El reparto
en producción es:

```
WhatsApp (Meta) ──webhook HTTPS──▶ Servicio Node (host externo)
                                        │ JSON-RPC
                                        ▼
                                  Odoo.sh (CRM)
```

- **Odoo.sh**: base de datos real, usuarios, equipos de venta y API key.
- **Host externo**: este repositorio (`npm start`), con un volumen persistente
  para `.data/state.json`.
- **Meta**: apunta el webhook al host externo.

**Regla de oro: una sola instancia del servicio.** El estado (sesiones,
idempotencia y cola de leads) vive en un archivo JSON; dos réplicas se pisan.

---

## 2. Preparar Odoo.sh

### 2.1 URL y nombre de la base

1. Entra al proyecto en Odoo.sh y abre la rama **production**.
2. Copia la URL pública que muestra (normalmente `https://<proyecto>.odoo.com`).
   Esa va en `ODOO_URL`, **sin barra final**.
3. El nombre de la base **no se adivina**. En Odoo.sh abre **Shell** sobre
   production y ejecuta:

```bash
echo $PGDATABASE
```

Copia el resultado exacto en `ODOO_DB`. En staging el nombre es distinto:
repite el `echo` en el shell de staging.

### 2.2 Usuario de integración (no uses tu admin)

1. **Ajustes → Usuarios → Nuevo**.
2. Nombre: `Agente WhatsApp`; email real (puede ser una cuenta interna tipo
   `agente@tudominio.com`).
3. Permisos: **Ventas → Administrador de ventas**. Es lo recomendable porque el
   agente escribe `user_id` de *otro* vendedor al asignar el lead; con
   "Solo mis documentos" Odoo puede rechazar esa escritura. También necesita
   crear `mail.activity` y publicar en el chatter.
4. Guarda, asigna contraseña e inicia sesión **como ese usuario** (la API key es
   personal; el admin no puede generarla por otro).
5. **Preferencias → Seguridad de la cuenta → Nueva clave API**. Cópiala en ese
   momento: solo se muestra una vez. Va en `ODOO_API_KEY`.

> Si prefieres mínimo privilegio: usuario con Ventas "Todos los documentos" +
> acceso a CRM y a los equipos que vayas a asignar. Si aparece `AccessError`,
> vuelve a Administrador de ventas.

### 2.3 Equipo y líder

1. **CRM → Configuración → Equipos de venta**.
2. Abre el equipo que recibirá los leads (ej. "Sales") y verifica que tenga
   **Team Leader** (`crm.team.user_id`).
3. El ID del equipo está en la URL (`.../crm.team/1`) o en modo desarrollador.
   Va en `ODOO_TEAM_ID`.

Comportamiento implementado:

| Caso | Asignación |
|---|---|
| El teléfono ya existe en `res.partner` y tiene **Salesperson** (`user_id`) | Se asigna a ese vendedor |
| Existe el contacto pero **sin** salesperson | Líder del equipo (`crm.team.user_id`) |
| No existe el contacto (o no hay equipo configurado) | Se crea el partner y se asigna al líder del equipo |

En ambos casos se crea una **actividad tipo Call** y se publica en el chatter con
el vendedor mencionado. No se le envía WhatsApp al vendedor: el WABA está
bloqueado para mensajes iniciados por el negocio y solo permite responder dentro
de la ventana de 24 h.

### 2.4 Staging (opcional pero recomendado)

1. En Odoo.sh crea una rama **staging** desde production.
2. En su Shell: `echo $PGDATABASE` y genera una API key con un usuario de staging.
3. Odoo.sh neutraliza correos y pagos en staging, así que puedes probar el flujo
   sin avisar a clientes reales.
4. Usa un `.env` aparte (`ODOO_URL` igual, `ODOO_DB` de staging) y, si quieres,
   un número de prueba de Meta.

Odoo.sh hace backup de producción, pero **no** de tu `.data/state.json`: ese
backup es tuyo (ver sección 10).

---

## 3. Elegir el host externo

Requisitos reales del servicio:

- Proceso siempre activo (sin "sleep" por inactividad).
- **Volumen persistente** montado en `/app/.data`.
- HTTPS con dominio propio (Meta exige certificado válido).
- Puerto público 443; el 3000 puede quedar interno.
- 256–512 MB de RAM sobran.

Opciones válidas:

- **VPS**: Hetzner, DigitalOcean, Linode, Contabo. Es lo más barato y controlas
  todo. Ejemplo completo en la sección 4.
- **PaaS con volúmenes**: Render (Web Service + Disk), Railway (Volume), Fly.io
  (Volume). Configura `npm start`, monta el volumen en `/app/.data`,
  `STATE_FILE=/app/.data/state.json`, health check `/health` y **1 sola
  instancia**.
- Evita planes gratuitos que duermen el proceso: Meta reintenta y pierdes
  mensajes.

### 3.1 Despliegue en Render (paso a paso)

El proyecto incluye un archivo `render.yaml` preparado para Render Blueprints.

#### Paso A: Subir el código a GitHub o GitLab
1. En GitHub/GitLab, crea un nuevo repositorio privado (ej. `whatsapp-odoo-agent`).
2. Vincula tu repositorio local y sube los cambios:
   ```bash
   git remote add origin <URL_DE_TU_REPOSITORIO_GIT>
   git push -u origin main
   ```

#### Paso B: Crear el servicio en Render
**Opción 1: Vía Blueprint (automática con `render.yaml`)**
1. En [dashboard.render.com](https://dashboard.render.com), haz clic en **New +** → **Blueprint**.
2. Conecta tu repositorio de GitHub/GitLab.
3. Render detectará el archivo `render.yaml`. Te mostrará el servicio y los campos de variables de entorno para que los completes o los configures luego.
4. Haz clic en **Apply**.

**Opción 2: Como Web Service manual**
1. En Render: **New +** → **Web Service**.
2. Conecta tu repositorio.
3. Configuración del servicio:
   - **Name**: `whatsapp-odoo-agent` (o el que prefieras).
   - **Runtime**: `Node`.
   - **Build Command**: `npm install --omit=dev`
   - **Start Command**: `npm start`
   - **Plan**: `Starter` ($7/mo recomendado para producción) o `Free` (para pruebas).
   - **Health Check Path**: `/health`
4. En **Advanced** → **Environment Variables**, añade las variables descritas en la [sección 8](#8-variables-de-entorno).
5. (Opcional en plan Starter): en **Disks**, añade un disco persistente montado en `/data` (1 GB) y define `STATE_FILE=/data/state.json`.

#### Paso C: Configurar el Webhook en Meta
Una vez desplegado, Render te asigna una URL HTTPS automática: `https://<tu-servicio>.onrender.com`.
1. Entra al Meta for Developers Dashboard → Tu App WhatsApp → Configuración de Webhooks.
2. **URL de devolución de llamada**: `https://<tu-servicio>.onrender.com/webhook`
3. **Identificador de verificación**: El mismo valor que pusiste en `WHATSAPP_VERIFY_TOKEN`.
4. Suscríbete al campo `messages`.

---

## 4. Despliegue en un VPS (paso a paso)

Ejemplo con Ubuntu 24.04, Docker y Caddy. Sirve igual para cualquier VPS.

### 4.1 Preparar el servidor

```bash
# como root o con sudo
adduser --disabled-password --gecos "" waagent
usermod -aG sudo waagent
# copia tu llave SSH a /home/waagent/.ssh/authorized_keys

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable

curl -fsSL https://get.docker.com | sh
usermod -aG docker waagent
```

Cierra la sesión y vuelve a entrar para que aplique el grupo `docker`.

### 4.2 DNS

En tu proveedor de dominio crea un registro **A**:

```
agente.tudominio.com → IP_DEL_VPS
```

Espera la propagación (`dig +short agente.tudominio.com`). Hazlo antes de Caddy
para que el certificado se emita sin problemas.

### 4.3 Subir el código

```bash
sudo mkdir -p /opt/wa-agent && sudo chown waagent:waagent /opt/wa-agent
# opción git:
git clone <URL_DEL_REPO> /opt/wa-agent
# opción sin git (desde tu máquina):
# rsync -avz --exclude node_modules --exclude .data ./ usuario@IP:/opt/wa-agent/
```

### 4.4 Variables de entorno

```bash
cd /opt/wa-agent
cp .env.example .env
chmod 600 .env
nano .env
```

Mínimo para producción:

```env
PORT=3000
WHATSAPP_APP_SECRET=...
WHATSAPP_VERIFY_TOKEN=un-token-largo-y-aleatorio
WHATSAPP_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...

ODOO_URL=https://<proyecto>.odoo.com
ODOO_DB=<salida de echo $PGDATABASE>
ODOO_EMAIL=agente@tudominio.com
ODOO_API_KEY=...
ODOO_TEAM_ID=1

STATE_FILE=.data/state.json
OUTBOX_INTERVAL_MS=60000

# opcional
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=gpt-4o-mini
```

`STATE_FILE` es **relativo a `/app`** dentro del contenedor, por eso el volumen va
a `/app/.data` y no a `/opt/wa-agent/.data/state.json`.

### 4.5 Construir y arrancar

```bash
cd /opt/wa-agent
mkdir -p data

docker build -t wa-agent .

docker run -d \
  --name wa-agent \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:3000:3000 \
  -v /opt/wa-agent/data:/app/.data \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  wa-agent
```

Verifica:

```bash
docker ps
docker logs -f wa-agent
curl http://127.0.0.1:3000/health
```

Debe responder algo como:

```json
{"status":"ok","whatsapp":"configurado","odoo":"configurado","llm":"modo reglas"}
```

Si dice "sin credenciales", el `.env` no se está leyendo o faltan variables.

### 4.6 Equivalente con docker-compose (opcional)

`docker-compose.yml`:

```yaml
services:
  wa-agent:
    build: .
    container_name: wa-agent
    restart: unless-stopped
    env_file: .env
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - ./data:/app/.data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

```bash
docker compose up -d --build
docker compose logs -f
```

---

## 5. HTTPS con Caddy

```bash
sudo apt install -y caddy
sudo nano /etc/caddy/Caddyfile
```

```caddyfile
agente.tudominio.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
curl -s https://agente.tudominio.com/health
```

Caddy emite y renueva el certificado solo. Si falla, revisa que el DNS ya apunte
al VPS y que 80/443 estén abiertos.

---

## 6. Alternativa sin Docker (systemd)

```bash
sudo apt install -y nodejs npm
cd /opt/wa-agent && npm ci --omit=dev
sudo useradd --system --home /opt/wa-agent waagent || true
sudo mkdir -p /opt/wa-agent/.data && sudo chown -R waagent:waagent /opt/wa-agent
```

`/etc/systemd/system/wa-agent.service`:

```ini
[Unit]
Description=Agente WhatsApp Odoo
After=network.target

[Service]
User=waagent
WorkingDirectory=/opt/wa-agent
EnvironmentFile=/opt/wa-agent/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wa-agent
sudo journalctl -u wa-agent -f
```

---

## 7. Configurar Meta

1. En [developers.facebook.com](https://developers.facebook.com) abre tu app →
   **WhatsApp → Configuration**.
2. **Callback URL**: `https://agente.tudominio.com/webhook`
3. **Verify token**: el mismo valor de `WHATSAPP_VERIFY_TOKEN`.
4. Pulsa **Verify and save**. Meta hace un GET con `hub.challenge`; el servicio
   responde el reto si el token coincide.
5. Suscríbete al campo **messages**.
6. Confirma que `WHATSAPP_APP_SECRET` es el *App secret* de esa app: sin él,
   todos los POST llegan con firma inválida y se descartan con 401.

> **Importante:** WhatsApp Cloud API admite un callback por app. Ahora mismo ese
> callback apunta a Odoo (`https://odonessas-mrmotor.odoo.com/whatsapp/webhook`).
> Al cambiarlo, **Odoo deja de recibir esos eventos**. Si quieres conservar la
> integración nativa de Odoo, necesitas otra app de Meta (u otro número) para el
> agente; si no, el agente pasa a ser el único que recibe los mensajes de ese
> número.

---

## 8. Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `PORT` | No (3000) | Puerto interno del servicio |
| `WHATSAPP_APP_SECRET` | Sí | App secret de Meta; valida `X-Hub-Signature-256` |
| `WHATSAPP_VERIFY_TOKEN` | Sí | Token propio para la verificación GET del webhook |
| `WHATSAPP_TOKEN` | Sí | Token de acceso para enviar respuestas |
| `WHATSAPP_PHONE_NUMBER_ID` | No | ID del número; informativo |
| `ODOO_URL` | Sí | URL de Odoo.sh, sin barra final |
| `ODOO_DB` | Sí | Nombre real de la base (`echo $PGDATABASE`) |
| `ODOO_EMAIL` | Sí | Login del usuario de integración |
| `ODOO_API_KEY` | Sí | API key de ese usuario |
| `ODOO_TEAM_ID` | No | Equipo cuyo líder recibe los leads sin vendedor |
| `STATE_FILE` | No (`/.data/state.json`) | Ruta del estado persistente |
| `OUTBOX_INTERVAL_MS` | No (60000) | Frecuencia de reintento de leads encolados |
| `LLM_BASE_URL` | No | Endpoint compatible con OpenAI |
| `LLM_API_KEY` | No | Clave del LLM |
| `LLM_MODEL` | No (`gpt-4o-mini`) | Modelo a usar |

---

## 9. Validación extremo a extremo

1. **Health**: `curl https://agente.tudominio.com/health` → todo "configurado".
2. **Verificación manual del webhook**:

```bash
curl -i "https://agente.tudominio.com/webhook?hub.mode=subscribe&hub.verify_token=TU_TOKEN&hub.challenge=123"
```

Debe devolver `123` con estado 200; con token incorrecto, 403.

3. **Mensaje real**: escribe "hola" desde un número permitido (en modo prueba,
   los números agregados a la app).
4. **Logs**: `docker logs -f wa-agent` debe mostrar `Mensaje entrante de ...` y
   luego `Lead creado en Odoo: id=...`.
5. **Odoo**: verifica lead, etapa, etiquetas, `user_id`, actividad Call y mensaje
   en el chatter.
6. **Persistencia**: a mitad de una conversación ejecuta `docker restart wa-agent`
   y continúa. La sesión debe seguir y el mensaje repetido debe ignorarse por
   idempotencia.
7. **Asignación**: prueba un contacto existente con vendedor y otro nuevo; el
   primero va al vendedor, el segundo al líder.
8. Borra los leads y contactos de prueba al terminar.

---

## 10. Operación, backups y actualizaciones

```bash
# logs
docker logs --tail 200 wa-agent

# actualizar
cd /opt/wa-agent
git pull
docker build -t wa-agent .
docker rm -f wa-agent
# repetir el docker run de 4.5

# backup del estado (sesiones + outbox)
tar czf /opt/backups/wa-state-$(date +%F).tgz -C /opt/wa-agent data
```

Programa el backup con cron y guárdalo fuera del VPS. Si algún día hay más de una
instancia, hay que mover el estado a PostgreSQL/Redis; con una sola, el JSON
atómico es suficiente.

**Rollback**: apunta el callback de Meta de vuelta a Odoo y `docker stop wa-agent`.
El volumen queda intacto.

---

## 11. Problemas típicos

| Síntoma | Causa / solución |
|---|---|
| `GET /webhook` devuelve 403 | `WHATSAPP_VERIFY_TOKEN` distinto al de Meta, o reiniciaste sin recargar el `.env` |
| Meta no guarda el callback | DNS sin propagar, certificado inválido, ruta distinta de `/webhook` o el servicio caído |
| POST con 401 "Firma inválida" | `WHATSAPP_APP_SECRET` incorrecto, o un proxy que altera el cuerpo |
| 502 en el dominio | Contenedor caído: `docker ps`, `docker logs`; revisa que escuche en 3000 |
| `ODOO_DB` inválido | Usa `echo $PGDATABASE` en el Shell de Odoo.sh, no el nombre del proyecto |
| `AccessError` al crear/asignar | Usuario sin Administrador de ventas o sin acceso al equipo |
| Lead creado sin vendedor | Contacto sin salesperson y equipo sin Team Leader, o `ODOO_TEAM_ID` incorrecto |
| Lead creado pero sin actividad/chatter | Faltan permisos sobre actividades o el usuario no puede publicar en el lead |
| Sesiones se pierden al desplegar | Volumen no montado o `STATE_FILE` con ruta distinta de `/app/.data/...` |
| Mensajes duplicados | Debe haber una sola instancia; la idempotencia cubre 24 h |
| Error 131000 / 141006 | WABA bloqueado para mensajes iniciados por el negocio: solo respuestas dentro de 24 h |

---

## 12. Advertencias técnicas

- **JSON-RPC está en salida**: `/jsonrpc` está deprecado desde Odoo 19 y
  `common/object` desaparece en Odoo 22 (otoño 2028). Funciona hoy, pero conviene
  migrar `src/odoo.js` a la API **JSON-2** (`/json/2/<modelo>/<método>`) antes de
  que se acerque la fecha.
- **No pongas el servicio en Odoo.sh** aunque el proyecto tenga "shell": no está
  pensado para daemons ni procesos persistentes, y un redeploy te borraría el
  estado.

---

## Resumen

Odoo.sh aporta la base y los usuarios; el agente vive en un VPS barato con Docker
+ Caddy, un volumen para `.data`, y Meta apuntando a
`https://tu-dominio/webhook`. Cloudways es solo una de las muchas opciones y su
verificación telefónica no bloquea el despliegue.
