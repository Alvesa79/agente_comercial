# Manual de Usuario: Agente Comercial WhatsApp + Odoo CRM

**Guía de Uso y Operación Comercial**

---

## 1. ¿Qué es y qué hace el Agente Comercial?

El **Agente Comercial de WhatsApp** es un asistente automatizado diseñado para atender a tus prospectos y clientes en tiempo real a través de WhatsApp, recolectar sus necesidades de compra y registrar automáticamente la oportunidad en el CRM de tu empresa en **Odoo**, asignándola al vendedor correspondiente.

### Beneficios clave:
* **Respuesta en segundos las 24 horas del día**, incluso fines de semana y festivos.
* **Calificación automática**: Filtra prospectos pidiéndoles nombre, necesidad, presupuesto aproximado y ubicación.
* **Cero trabajo manual para los asesores**: El vendedor recibe el lead en su CRM listo con todos los datos del cliente y una tarea de llamada programada.

---

## 2. Experiencia del Cliente en WhatsApp

Cuando una persona escribe por primera vez al número de WhatsApp de la empresa, el agente lo guía en un diálogo natural de 4 preguntas:

```
[Cliente]  Hola, buenas tardes, me gustaría información.
[Agente]   ¡Hola! 👋 Soy el asistente comercial. Para empezar, ¿cuál es tu nombre completo?

[Cliente]  Carlos Pérez
[Agente]   Gracias, Carlos Pérez. ¿Qué producto o servicio te interesa?

[Cliente]  Necesito cotizar un motor para camioneta diésel.
[Agente]   ¿Qué presupuesto aproximado tienes en mente? (puedes decir "no lo sé")

[Cliente]  Alrededor de 15 millones
[Agente]   ¿En qué ciudad o zona estás?

[Cliente]  Bogotá
[Agente]   Listo ✅ tu solicitud quedó registrada (folio #13891). Un asesor te contactará
           por WhatsApp a la brevedad. ¿Algo más en lo que te pueda ayudar?
```

### Comandos especiales que el cliente puede usar:
* **Solicitar un humano**: Si el cliente escribe palabras como *"asesor"*, *"humano"*, *"persona real"* o *"hablar con alguien"*, el bot detiene las preguntas, crea la iniciativa en Odoo con los datos que tenga hasta el momento y responde:
  > *"Con gusto, en un momento un asesor humano continuará la conversación. 🙌"*
* **Cancelar la conversación**: Si el cliente escribe *"cancelar"*, *"salir"* o *"stop"*, el agente reinicia la sesión:
  > *"Entendido. Si necesitas algo más, escríbeme cuando quieras. 👋"*
* **Tiempo de inactividad**: Si el cliente deja de responder durante más de 30 minutos, la sesión se cierra automáticamente para permitir una nueva consulta en el futuro.

---

## 3. Guía para el Equipo de Ventas (Uso en Odoo CRM)

Los vendedores no necesitan usar consolas ni aplicaciones externas; todo su trabajo continúa dentro de **Odoo**.

### 3.1 Dónde ver los nuevos prospectos
1. Entra a tu Odoo y abre la aplicación **CRM** (Iniciativas / Flujo de ventas).
2. Verás las tarjetas creadas con el formato: `[Nombre del Cliente] - [Producto que busca]`.
3. Al abrir la oportunidad, encontrarás:
   - **Teléfono**: El número de WhatsApp del cliente en formato internacional.
   - **Notas / Descripción**: Un resumen completo y ordenado con:
     * Nombre reportado
     * Producto o necesidad
     * Presupuesto aproximado
     * Ciudad o ubicación
     * Fuente: *Agente IA de WhatsApp*
     * ID de referencia único de WhatsApp

### 3.2 ¿A quién se le asigna el prospecto?
El sistema cuenta con una regla de asignación inteligente:
* **Si el cliente ya existía en tu base de datos de Odoo** (reconocido por su número de teléfono) y ya tenía un vendedor asignado: el lead se asigna **automáticamente a ese mismo vendedor**.
* **Si es un cliente nuevo**: el lead se asigna automáticamente al **Líder del Equipo de Ventas** (`Team Leader`) configurado en Odoo.

### 3.3 Tareas automáticas en el Chatter
En la parte derecha de la oportunidad en Odoo (el *Chatter*), el agente:
* Crea una **Actividad tipo Llamada prioritaria** asignada al vendedor.
* Publica un mensaje mencionando al asesor: *"Nuevo lead desde WhatsApp asignado a @Vendedor"*.

---

## 4. Guía para el Administrador del Sistema

### 4.1 Cómo monitorear si el servicio está en línea
Puedes revisar el estado de tu agente en cualquier momento abriendo en tu navegador:
```text
https://tu-servicio.onrender.com/health
```
Te responderá un estado como este:
```json
{
  "status": "ok",
  "whatsapp": "configurado",
  "odoo": "configurado",
  "llm": "modo reglas"
}
```
Si alguno de los servicios dice *"sin credenciales"*, significa que falta revisar las variables correspondientes en Render.

### 4.2 Cómo cambiar las credenciales o pasar a Odoo de Producción
1. Entra a **[dashboard.render.com](https://dashboard.render.com)**.
2. Selecciona tu servicio **`whatsapp-odoo-agent`**.
3. Haz clic en la pestaña **Environment**.
4. Modifica las variables deseadas (por ejemplo `ODOO_URL`, `ODOO_DB`, `WHATSAPP_TOKEN`, etc.).
5. Haz clic en **Save Changes**. El servidor se reiniciará automáticamente con la nueva configuración en 30 segundos.

---

## 5. Preguntas Frecuentes

**¿Qué pasa si Odoo se cae o está en mantenimiento?**  
El agente cuenta con una cola de seguridad (*Outbox*). Guarda las solicitudes recibidas y, en cuanto Odoo vuelve a estar disponible, las envía automáticamente sin perder ningún prospecto.

**¿Qué pasa si el cliente envía un audio o una foto?**  
El agente le responderá amablemente indicándole que por el momento solo procesa mensajes de texto, invitándolo a escribir su respuesta para poder continuar.

**¿Cuánto tiempo dura el número de prueba de WhatsApp?**  
El número de prueba de Meta está activo permanentemente para desarrollo, pero los tokens temporales vencen cada 24 horas. Para producción, se debe registrar una línea real de la empresa y generar un Token de Usuario del Sistema permanente en Meta Business Suite.
