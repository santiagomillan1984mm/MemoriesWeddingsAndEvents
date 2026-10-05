// Función de Vercel: lee cotizaciones e itinerarios con Claude.
// La clave vive en Vercel → Settings → Environment Variables → ANTHROPIC_API_KEY (nunca en la página).
const SB_URL = process.env.SUPABASE_URL || 'https://fpizlsefbcmhzmkwynxv.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_eynYPP8nIpmbP3zHHoujOA_VmZ8GBI9';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

const CATS = ['Lugar','Alimentos y bebidas','Fotografía','Video','Música y DJ','Flores y decoración','Mobiliario y mantelería','Iluminación y audio','Pastel y postres','Vestido y atuendo','Belleza','Invitaciones y papelería','Ceremonia','Transporte','Hospedaje','Recuerdos y regalos','Honorarios Memories','Otros'];
const NUM = { type: ['number', 'null'] };
const TXT = { type: ['string', 'null'] };
const IMPUESTOS = { type: 'array', description: 'Cada impuesto tal como aparece: IVA 16%, ISH, servicio, propina, etc.', items: { type: 'object', properties: {
  nombre: { type: 'string', description: 'Texto exacto, por ejemplo "IVA 16%"' }, tasa: { ...NUM, description: 'Porcentaje, por ejemplo 16' }, importe: NUM }, required: ['nombre'] } };
const CONCEPTO = { type: 'object', properties: {
  seccion: { ...TXT, description: 'Nombre exacto de la sección o encabezado del documento al que pertenece (por ejemplo "ALIMENTOS Y BEBIDAS"). null si no hay secciones.' },
  concepto: { type: 'string', description: 'Texto exacto del concepto, con sus mayúsculas, acentos y palabras tal cual' },
  detalle: { ...TXT, description: 'Descripción o detalle debajo del concepto, tal cual' },
  cantidad: NUM, unidad: { ...TXT, description: 'pza, persona, hora, etc.' }, precio_unitario: NUM, importe: NUM }, required: ['concepto'] };
const TIPO = { type: 'array', description: 'Cada tipografía distinta que se ve en las capturas de la página web o en papelería', items: { type: 'object', properties: {
          uso: { type: 'string', description: 'Para qué la usan: Nombres de los novios, Títulos, Subtítulos, Texto, Fechas, etc.' },
          fuente: { type: 'string', description: 'Nombre exacto más probable de la fuente, por ejemplo Arial, Helvetica, Times New Roman, Georgia, Garamond, Playfair Display, Cormorant Garamond, Bodoni Moda, Cinzel, Montserrat, Lato, Open Sans, Raleway, Josefin Sans, Poppins, Great Vibes, Allura, Parisienne, Pinyon Script, Alex Brush, Dancing Script, Sacramento, Tangerine, Italianno' },
          alternativas: { type: 'array', items: { type: 'string' }, description: '2 o 3 fuentes muy parecidas, de preferencia gratuitas de Google Fonts' },
          estilo: { type: 'string', description: 'serif clásica, serif moderna/didona, sans geométrica, sans humanista, script caligráfica, script manuscrita, etc.' },
          confianza: { type: 'string', enum: ['alta', 'media', 'baja'] } }, required: ['uso', 'fuente', 'estilo', 'confianza'] } };
const TIPO_DOC = { type: 'string', enum: ['cotizacion', 'presupuesto', 'itinerario', 'contrato', 'otro'], description: 'cotizacion = de un proveedor; presupuesto = presupuesto general de la boda con varias áreas o proveedores; itinerario = programa con horas' };

const TOOLS = {
  cotizacion: {
    name: 'registrar_cotizacion',
    description: 'Transcribe tal cual la cotización de un proveedor de boda.',
    input_schema: {
      type: 'object',
      properties: {
        tipo_documento: TIPO_DOC,
        proveedor: { ...TXT, description: 'Nombre comercial del proveedor, como aparece' },
        categoria: { type: 'string', enum: CATS },
        moneda: { type: 'string', enum: ['MXN', 'USD'] },
        conceptos: { type: 'array', description: 'Todos los renglones en el mismo orden del documento', items: CONCEPTO },
        subtotal: NUM,
        descuento: NUM,
        impuestos: IMPUESTOS,
        total: { ...NUM, description: 'Total final a pagar tal como viene en el documento (con IVA si lo incluye)' },
        anticipo: { ...NUM, description: 'Monto de anticipo o apartado, si se menciona' },
        vigencia: { ...TXT, description: 'Fecha de vigencia AAAA-MM-DD si aparece' },
        incluye: { ...TXT, description: 'Lo que incluye, con las palabras del documento' },
        condiciones: { ...TXT, description: 'Condiciones de pago, cancelación, horas extra, tal cual' },
        dudosos: { type: 'array', items: { type: 'string' }, description: 'Campos que no se pudieron leer con seguridad: proveedor, total, anticipo, vigencia, categoria, impuestos, conceptos.N' },
        nota: { ...TXT, description: 'Aviso corto para la planner si algo no cuadra' }
      },
      required: ['tipo_documento', 'categoria', 'moneda', 'conceptos', 'dudosos']
    }
  },
  presupuesto: {
    name: 'registrar_presupuesto',
    description: 'Transcribe tal cual un presupuesto de boda con sus secciones.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: TXT,
        moneda: { type: 'string', enum: ['MXN', 'USD'] },
        secciones: { type: 'array', description: 'Las secciones en el mismo orden y con el mismo nombre del documento', items: { type: 'object', properties: {
          nombre: { type: 'string', description: 'Nombre exacto de la sección, por ejemplo "Alimentos y Bebidas"' },
          conceptos: { type: 'array', items: { type: 'object', properties: {
            concepto: { type: 'string', description: 'Texto exacto' }, proveedor: TXT, detalle: TXT, cantidad: NUM, unidad: TXT, precio_unitario: NUM, importe: NUM }, required: ['concepto'] } },
          subtotal: NUM }, required: ['nombre', 'conceptos'] } },
        subtotal: NUM,
        impuestos: IMPUESTOS,
        total: NUM,
        notas: TXT,
        dudosos: { type: 'array', items: { type: 'string' } }
      },
      required: ['secciones', 'dudosos']
    }
  },
  itinerario: {
    name: 'registrar_itinerario',
    description: 'Registra los momentos de un itinerario de boda.',
    input_schema: {
      type: 'object',
      properties: {
        momentos: { type: 'array', items: { type: 'object', properties: {
          hora: { ...TXT, description: 'Hora de inicio en formato 24 h HH:MM, por ejemplo 17:30. null si ese momento no trae hora' },
          duracion_min: NUM,
          momento: { type: 'string', description: 'Texto exacto del momento' }, notas: TXT }, required: ['momento'] } },
        dudosos: { type: 'array', items: { type: 'string' } }
      },
      required: ['momentos', 'dudosos']
    }
  },
  tipografia: {
    name: 'registrar_tipografia',
    description: 'Identifica las tipografías de capturas de la página web de una boda.',
    input_schema: { type: 'object', properties: { tipografia: TIPO }, required: ['tipografia'] }
  },
  inspiracion: {
    name: 'registrar_inspiracion',
    description: 'Describe la inspiración visual de una boda a partir de fotos.',
    input_schema: {
      type: 'object',
      properties: {
        estilo: { type: 'string', description: 'Una o dos frases con el estilo general' },
        paleta: { type: 'array', items: { type: 'object', properties: { nombre: { type: 'string' }, hex: { type: 'string' }, rol: { type: 'string', enum: ['principal', 'acento'], description: 'principal = colores dominantes que ocupan mucha superficie o neutros de base (fondos, mantelería, follaje, blancos, beiges, grises); acento = colores con más intensidad que se usan poco para resaltar detalles (metales como dorado o cobre, flores de contraste, listones, papelería)' } }, required: ['nombre', 'hex', 'rol'] }, description: '4 a 8 colores: primero los principales (2 a 5) y luego los de acento (1 a 3), siguiendo la regla 60-30-10' },
        tipografia: TIPO,
        flores: { type: 'array', items: { type: 'string' }, description: 'Flores y follajes que se reconocen' },
        ceremonia: { type: 'array', items: { type: 'string' }, description: 'Ideas de la ceremonia: arco, pasillo, sillas, altar' },
        decoracion: { type: 'array', items: { type: 'string' }, description: 'Elementos de decoración, texturas, mobiliario, iluminación' },
        sugerencias: { type: 'array', items: { type: 'string' }, description: '3 a 5 ideas concretas para llevarlo a la boda' }
      },
      required: ['estilo', 'paleta']
    }
  }
};

const FIEL = 'Transcribe TAL CUAL: copia cada texto exactamente como está escrito, con las mismas mayúsculas y minúsculas, acentos, palabras y orden. No resumas, no traduzcas, no corrijas ni cambies nombres. Respeta las secciones y separaciones del documento con su nombre exacto. Copia los montos sin redondear.';
function prompt(mode, ctx) {
  const c = ctx || {};
  const boda = `Boda: ${c.pareja || 'sin nombre'}; fecha ${c.fecha || 'sin fecha'}; ${c.invitados || '?'} invitados; moneda habitual ${c.moneda || 'MXN'}.`;
  if (mode === 'itinerario') return `Eres asistente de una wedding planner en México. Lee este itinerario de boda y registra cada momento en el orden del documento. ${boda} La hora va en formato 24 h (5:00 pm = 17:00). Copia el nombre de cada momento tal cual. Si un momento no tiene hora pero sí duración, deja hora en null y pon la duración. Si el documento es una tabla, cada renglón es un momento.`;
  if (mode === 'presupuesto') return `Eres asistente de una wedding planner en México. Lee este presupuesto de boda. ${boda}
${FIEL}
Cada encabezado o separación del documento es una sección (por ejemplo "Alimentos y Bebidas", "Decoración"). Los renglones de subtotal o total de una sección van en su subtotal, no como concepto. Si aparece IVA u otro impuesto (por ejemplo IVA 16%), regístralo en impuestos con su importe tal cual. El total es el que dice el documento. Si un dato no aparece, usa null: no inventes.`;
  if (mode === 'tipografia') return `Eres experta en tipografía y ayudas a una wedding planner. Estas son capturas de pantalla de la página web de la boda de unos novios. ${boda}
Identifica cada tipografía distinta que se ve en el diseño de la página (nombres de los novios, títulos, subtítulos, texto, fechas, botones) y di el nombre exacto más probable de cada fuente, por ejemplo Arial, Helvetica, Times New Roman, Georgia, Garamond, Playfair Display, Cormorant Garamond, Bodoni Moda, Cinzel, Montserrat, Lato, Open Sans, Raleway, Josefin Sans, Poppins, Great Vibes, Allura, Parisienne, Pinyon Script, Alex Brush, Dancing Script, Sacramento, Tangerine, Italianno.
Fíjate en la forma de las letras: remates (serif o sin remate), contraste entre trazos gruesos y delgados, la forma de la a, g, R, Q, M y de las mayúsculas en cursiva, el ancho y la altura de las minúsculas.
Ignora todo lo del celular o el navegador (hora, batería, barra de direcciones, botones del sistema): esas letras son del teléfono, no de la página.
Si no estás segura del nombre exacto, da el más parecido con confianza media o baja y 2 o 3 alternativas.`;
  if (mode === 'inspiracion') return `Eres asistente de una wedding planner en México. Estas son fotos de inspiración que juntaron los novios y la planner, agrupadas por sección (inspiración general, flores, ceremonia, decoración). Describe el estilo, saca una paleta de colores con nombres bonitos en español y su hex, reconoce flores y elementos, y da sugerencias concretas. ${boda}
Muchas fotos son CAPTURAS DE PANTALLA de la página web de la boda (vienen marcadas, o se nota por el formato de celular). En esas:
- Ignora por completo todo lo del celular o del navegador: barra de estado, hora, wifi, batería, señal, notificaciones, barra de direcciones, pestañas, botones del navegador, teclado y cualquier ícono del sistema.
- Concéntrate solo en el diseño de la página web: sus colores (fondo, textos, detalles, ilustraciones, fotos), la tipografía que escogieron (estilo y nombre probable de la fuente) y el estilo gráfico.
- La paleta de una captura sale del DISEÑO de la página: color de fondo, de los textos, recuadros, botones, ornamentos e ilustraciones. NO tomes colores de las fotografías ni de las ilustraciones o dibujos del lugar que aparecen dentro de la página (mar, cielo, arena, vegetación, edificios, mapas, ilustraciones del venue, piel, ropa de la gente): son contenido, no el diseño. Solo cuentan el fondo, los textos, los recuadros, botones, líneas y ornamentos pequeños del diseño. Nunca uses colores de la interfaz del teléfono.
- En las fotos de inspiración que NO son capturas (flores, decoración, ceremonia), sí toma los colores de la foto.
Si alguna foto pide tipografía, llena "tipografia": identifica cada fuente distinta por su nombre (Arial, Times New Roman, Playfair Display…) mirando la forma de las letras (remates, contraste de trazo, la forma de la g, la a, la R, la Q, las mayúsculas en cursiva). Si no estás segura del nombre exacto, da el más parecido, márcalo con confianza media o baja y da alternativas.
Cada foto viene con la indicación "TOMAR SOLO": de esa foto toma únicamente lo indicado (por ejemplo, si dice solo colores y tipografía, no describas flores ni decoración de esa foto; si no incluye colores, no uses sus colores para la paleta; si dice "nada", úsala solo como referencia general).`;
  return `Eres asistente de una wedding planner en México. Lee esta cotización de un proveedor. ${boda}
${FIEL}
- Registra todos los renglones en el orden del documento. Si el documento tiene secciones o encabezados, pon en cada concepto su sección con el nombre exacto.
- Impuestos: si aparece IVA (por ejemplo IVA 16%) u otro cargo, regístralo en impuestos con su nombre exacto y su importe. Si dice "más IVA" sin el monto, calcula el 16% del subtotal, ponlo en impuestos y anótalo en dudosos ("impuestos").
- El total es el total final del documento, con IVA si lo incluye. Si un dato no aparece, usa null: no inventes.
- Categoría: banquete, comida, bebidas, barra y mixología van en "Alimentos y bebidas".
- tipo_documento: indica si en realidad es un presupuesto general de toda la boda, un itinerario o un contrato.
Escribe en "dudosos" cualquier campo que no pudiste leer con seguridad.`;
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
  if (!rows.length) return send(403, { error: 'Solo la cuenta de la planner puede usar la lectura con IA.' });

  const body = await readJson(req);
  const mode = ['itinerario', 'presupuesto', 'inspiracion', 'tipografia'].includes(body.mode) ? body.mode : 'cotizacion';
  const content = [];
  try {
    if (mode === 'inspiracion' || mode === 'tipografia') {
      const imgs = (Array.isArray(body.images) ? body.images : []).slice(0, 12);
      if (!imgs.length) return send(400, { error: 'No llegaron fotos.' });
      for (const im of imgs) {
        if (im.seccion) content.push({ type: 'text', text: 'Sección: ' + String(im.seccion).slice(0, 40) });
        if (im.b64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: im.b64 } });
      }
    } else if (body.text) {
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
  content.push({ type: 'text', text: prompt(mode, body.context) + '\n\nResponde únicamente llamando a la herramienta ' + TOOLS[mode].name + '.' });

  const tool = TOOLS[mode];
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: mode === 'presupuesto' || mode === 'cotizacion' ? 12000 : 4096, tools: [tool], tool_choice: { type: 'auto' }, messages: [{ role: 'user', content }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.error?.message || ('Error ' + r.status);
    if (/credit|billing/i.test(msg)) return send(402, { error: 'Tu cuenta de Anthropic no tiene saldo. Agrega crédito en console.anthropic.com.' });
    return send(502, { error: 'La IA no pudo leer el archivo: ' + msg });
  }
  let out = (j.content || []).find(b => b.type === 'tool_use');
  if (!out) { const txt = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'); const m = txt.match(/\{[\s\S]*\}/); if (m) { try { out = { input: JSON.parse(m[0]) }; } catch (e) {} } }
  if (!out) return send(502, { error: 'La IA no devolvió datos. Intenta de nuevo o captura a mano.' });
  return send(200, { mode, data: out.input });
};
