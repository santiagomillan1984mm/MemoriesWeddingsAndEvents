// Función de Vercel: lee cotizaciones e itinerarios con Claude.
// La clave vive en Vercel → Settings → Environment Variables → ANTHROPIC_API_KEY (nunca en la página).
const SB_URL = process.env.SUPABASE_URL || 'https://fpizlsefbcmhzmkwynxv.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_eynYPP8nIpmbP3zHHoujOA_VmZ8GBI9';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

const CATS = ['Lugar','Banquete','Bebidas y barra','Fotografía','Video','Música y DJ','Flores y decoración','Mobiliario y mantelería','Iluminación y audio','Pastel y postres','Vestido y atuendo','Belleza','Invitaciones y papelería','Ceremonia','Transporte','Hospedaje','Recuerdos y regalos','Honorarios Memories','Otros'];

const TOOLS = {
  cotizacion: {
    name: 'registrar_cotizacion',
    description: 'Registra los datos leídos de la cotización de un proveedor de boda.',
    input_schema: {
      type: 'object',
      properties: {
        proveedor: { type: ['string', 'null'], description: 'Nombre comercial del proveedor' },
        categoria: { type: 'string', enum: CATS },
        moneda: { type: 'string', enum: ['MXN', 'USD'] },
        conceptos: { type: 'array', items: { type: 'object', properties: {
          concepto: { type: 'string' }, cantidad: { type: ['number', 'null'] }, precio_unitario: { type: ['number', 'null'] }, importe: { type: ['number', 'null'] } }, required: ['concepto'] } },
        subtotal: { type: ['number', 'null'] },
        impuestos: { type: ['number', 'null'] },
        total: { type: ['number', 'null'], description: 'Total final a pagar, con impuestos si vienen' },
        anticipo: { type: ['number', 'null'], description: 'Monto de anticipo o apartado, si se menciona' },
        vigencia: { type: ['string', 'null'], description: 'Fecha de vigencia AAAA-MM-DD si aparece' },
        incluye: { type: ['string', 'null'], description: 'Resumen breve de lo que incluye' },
        condiciones: { type: ['string', 'null'], description: 'Condiciones de pago, cancelación, horas extra' },
        dudosos: { type: 'array', items: { type: 'string' }, description: 'Campos que no se pudieron leer con seguridad: proveedor, total, anticipo, vigencia, categoria, conceptos.N' },
        nota: { type: ['string', 'null'], description: 'Aviso corto para la planner si algo no cuadra' }
      },
      required: ['categoria', 'moneda', 'conceptos', 'dudosos']
    }
  },
  itinerario: {
    name: 'registrar_itinerario',
    description: 'Registra los momentos de un itinerario de boda.',
    input_schema: {
      type: 'object',
      properties: {
        momentos: { type: 'array', items: { type: 'object', properties: {
          hora: { type: 'string', description: 'Hora de inicio en formato 24 h HH:MM' }, momento: { type: 'string' }, notas: { type: ['string', 'null'] } }, required: ['hora', 'momento'] } },
        dudosos: { type: 'array', items: { type: 'string' } }
      },
      required: ['momentos', 'dudosos']
    }
  }
};

function prompt(mode, ctx) {
  const c = ctx || {};
  const boda = `Boda: ${c.pareja || 'sin nombre'}; fecha ${c.fecha || 'sin fecha'}; ${c.invitados || '?'} invitados; moneda habitual ${c.moneda || 'MXN'}.`;
  if (mode === 'itinerario') return `Eres asistente de una wedding planner en México. Lee este itinerario de boda y registra cada momento con su hora de inicio en formato 24 h. ${boda} No inventes horas: si un momento no tiene hora, déjalo fuera y menciónalo en dudosos.`;
  return `Eres asistente de una wedding planner en México. Lee esta cotización de un proveedor y registra los datos con la herramienta. ${boda}
Reglas: copia los montos tal como aparecen, sin redondear. Si el precio es por persona, calcula el importe con la cantidad indicada en el documento; si no hay cantidad, deja el importe en null y explícalo en "nota". Si el IVA viene aparte, el total debe incluirlo. Si un dato no aparece, usa null: no inventes. Escribe en "dudosos" cualquier campo que no pudiste leer con seguridad. Elige la categoría que mejor corresponda.`;
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; for await (const ch of req) chunks.push(ch);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

module.exports = async (req, res) => {
  const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
  if (req.method !== 'POST') return send(405, { error: 'Método no permitido' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return send(500, { error: 'Falta configurar ANTHROPIC_API_KEY en Vercel (Settings → Environment Variables) y volver a publicar.' });

  // Solo la planner puede usarla
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return send(401, { error: 'Inicia sesión otra vez.' });
  const h = { apikey: SB_KEY, Authorization: 'Bearer ' + token };
  const u = await fetch(SB_URL + '/auth/v1/user', { headers: h });
  if (!u.ok) return send(401, { error: 'Tu sesión expiró. Vuelve a entrar.' });
  const user = await u.json();
  const ps = await fetch(SB_URL + '/rest/v1/planner_settings?select=planner_id&planner_id=eq.' + encodeURIComponent(user.id), { headers: h });
  const rows = ps.ok ? await ps.json() : [];
  if (!rows.length) return send(403, { error: 'Solo la cuenta de la planner puede leer cotizaciones.' });

  const body = await readJson(req);
  const mode = body.mode === 'itinerario' ? 'itinerario' : 'cotizacion';
  const content = [];
  try {
    if (body.text) {
      content.push({ type: 'text', text: 'Contenido del documento:\n\n' + String(body.text).slice(0, 120000) });
    } else if (body.b64 && /^image\//.test(body.mime || '')) {
      content.push({ type: 'image', source: { type: 'base64', media_type: body.mime, data: body.b64 } });
    } else if (body.url) {
      if (!String(body.url).startsWith(SB_URL + '/storage/v1/')) return send(400, { error: 'Archivo no válido.' });
      const f = await fetch(body.url);
      if (!f.ok) return send(400, { error: 'No se pudo descargar el archivo para leerlo.' });
      const buf = Buffer.from(await f.arrayBuffer());
      const mime = body.mime || f.headers.get('content-type') || '';
      if (/pdf/.test(mime)) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } });
      else if (/^image\/(jpeg|png|gif|webp)/.test(mime)) content.push({ type: 'image', source: { type: 'base64', media_type: mime.split(';')[0], data: buf.toString('base64') } });
      else return send(400, { error: 'Formato no compatible. Sube PDF, foto (JPG o PNG), Word o Excel.' });
    } else return send(400, { error: 'No llegó ningún archivo.' });
  } catch (e) { return send(400, { error: 'No se pudo preparar el archivo: ' + e.message }); }
  content.push({ type: 'text', text: prompt(mode, body.context) });

  const tool = TOOLS[mode];
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, tools: [tool], tool_choice: { type: 'tool', name: tool.name }, messages: [{ role: 'user', content }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.error?.message || ('Error ' + r.status);
    if (/credit|billing/i.test(msg)) return send(402, { error: 'Tu cuenta de Anthropic no tiene saldo. Agrega crédito en console.anthropic.com.' });
    return send(502, { error: 'La IA no pudo leer el archivo: ' + msg });
  }
  const out = (j.content || []).find(b => b.type === 'tool_use');
  if (!out) return send(502, { error: 'La IA no devolvió datos. Intenta de nuevo o captura a mano.' });
  return send(200, { mode, data: out.input });
};
