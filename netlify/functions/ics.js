/* ============================================================
   Función serverless: devuelve el .ics de una próxima prueba con
   Content-Type text/calendar (inline). Así, al abrir el enlace desde el
   iPhone o el Mac, el sistema ABRE el calendario para añadir el evento en
   vez de descargar un archivo suelto.
   URL: /.netlify/functions/ics?id=<race_id>
   Solo lectura: clave pública (anon) de Supabase.
   ============================================================ */
'use strict';

const SUPABASE_URL = 'https://neeamkhbtoqsdxvsaogd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_R7anMfu6xfwlr7Ew3kMUbg_N1mqNRJb';

function p2(n) { return String(n).padStart(2, '0'); }
function esc(s) { return String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\r?\n/g, '\\n'); }

function construirICS(id, nombre, fecha, localidad, hora, cat) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const base = new Date(fecha + 'T00:00:00');
  const fmtF = d => '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate());
  const fmtH = d => fmtF(d) + 'T' + p2(d.getHours()) + p2(d.getMinutes()) + '00';
  let inicio, fin;
  if (/^\d{1,2}:\d{2}/.test(hora || '')) {
    const partes = hora.split(':');
    const d = new Date(base);
    d.setHours(parseInt(partes[0], 10), parseInt(partes[1], 10), 0, 0);
    inicio = 'DTSTART:' + fmtH(d);
    fin = 'DTEND:' + fmtH(new Date(d.getTime() + 2 * 3600e3)); // +2 h
  } else {
    inicio = 'DTSTART;VALUE=DATE:' + fmtF(base);
    fin = 'DTEND;VALUE=DATE:' + fmtF(new Date(base.getTime() + 864e5)); // día siguiente
  }
  const catU = cat ? Array.from(new Set(String(cat).split(/\s+/))).join(' ') : '';
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MFPP Cycling//Ranking//ES', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:mfpp-' + id + '@mfppcycling.com',
    'DTSTAMP:' + stamp, inicio, fin,
    'SUMMARY:' + esc(nombre),
    localidad ? 'LOCATION:' + esc(localidad) : '',
    'DESCRIPTION:' + esc('Prueba del calendario · MFPP Cycling' + (catU ? ' · ' + catU : '')),
    'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean).join('\r\n') + '\r\n';
}

exports.handler = async function (event) {
  const id = (event.queryStringParameters || {}).id;
  if (!id) return { statusCode: 400, body: 'Falta el parámetro id' };
  try {
    const url = SUPABASE_URL + '/rest/v1/races?select=id,name,date,notes&id=eq.' +
      encodeURIComponent(id) + '&limit=1';
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY }
    });
    const filas = await res.json();
    if (!Array.isArray(filas) || !filas.length) {
      return { statusCode: 404, body: 'Prueba no encontrada' };
    }
    const r = filas[0];
    let extra = {};
    try { extra = JSON.parse(r.notes || '{}') || {}; } catch (_) { extra = {}; }
    const cat = [extra.cat, extra.raceCat].filter(Boolean).join(' ');
    const ics = construirICS(r.id, r.name || 'Prueba', String(r.date || '').slice(0, 10),
      extra.localidad, extra.hora_inicio, cat);
    const nombreArchivo = (r.name || 'prueba').replace(/[^\w\-]+/g, '_').slice(0, 60) + '.ics';
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="' + nombreArchivo + '"',
        'Cache-Control': 'public, max-age=3600'
      },
      body: ics
    };
  } catch (e) {
    return { statusCode: 500, body: 'Error generando el calendario' };
  }
};
