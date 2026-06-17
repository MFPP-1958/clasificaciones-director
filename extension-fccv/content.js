/* ════════════════════════════════════════════════════════════════════════
   Asistente de inscripción FCCV · TBG-WIXUM
   ────────────────────────────────────────────────────────────────────────
   Inyecta un panel flotante en fccv.es para rellenar los DNI del formulario
   de inscripción UNO A UNO, sin teclear. El director mantiene el control:
   revisa y pulsa "Comprobar" (o lo automatiza con la casilla).

   Por qué un panel flotante y no un popup: el formulario RECARGA la página
   tras cada inscripción; el estado (lista de DNIs + por dónde vas) se guarda
   en chrome.storage.local y se restaura al recargar, así no se pierde.
   ════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  if(window.__fccvAsistenteCargado) return;     // evitar doble inyección
  window.__fccvAsistenteCargado = true;

  const KEY = 'fccv_asistente_estado';
  let estado = { dnis: [], idx: 0, autoComprobar: false };

  // ── Persistencia (sobrevive a recargas de la página) ──
  function guardar(){ try{ chrome.storage.local.set({ [KEY]: estado }); }catch(_){ } }
  function cargar(cb){
    try{ chrome.storage.local.get(KEY, r=>{ if(r && r[KEY]) estado = Object.assign(estado, r[KEY]); cb(); }); }
    catch(_){ cb(); }
  }

  // ── Localizar el campo DNI de forma robusta (sin depender de un id fijo) ──
  function findDniInput(){
    // 1) por placeholder "DNI"
    let el = document.querySelector('input[placeholder="DNI"]') ||
             document.querySelector('input[placeholder*="dni" i]');
    if(el) return el;
    // 2) por la etiqueta "DNI / ID Card number"
    const nodes = [...document.querySelectorAll('label,td,th,div,span,b,strong')]
      .filter(n => /dni\s*\/\s*id|n[uú]mero de dni|\bdni\b/i.test(n.textContent||''));
    for(const n of nodes){
      const cont = n.closest('tr,div,form,table') || n.parentElement;
      const inp = cont && cont.querySelector('input[type=text], input:not([type])');
      if(inp) return inp;
    }
    // 3) primer input de texto visible de la página
    return [...document.querySelectorAll('input[type=text], input:not([type])')]
      .find(i => i.offsetParent !== null) || null;
  }

  // ── Localizar el botón "Comprobar" ──
  function findComprobarBtn(){
    const cands = [...document.querySelectorAll('button, input[type=submit], input[type=button], a')];
    return cands.find(b => /comprobar/i.test((b.textContent||'') + ' ' + (b.value||''))) || null;
  }

  // ── Escribir un valor disparando los eventos que esperan los frameworks ──
  function setNativeValue(el, val){
    try{
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, val);
    }catch(_){ el.value = val; }
    el.dispatchEvent(new Event('input',  { bubbles:true }));
    el.dispatchEvent(new Event('change', { bubbles:true }));
  }

  function rellenarActual(){
    const dni = estado.dnis[estado.idx];
    if(!dni){ flash('No hay más DNIs en la lista.', '#b45309'); return; }
    const input = findDniInput();
    if(!input){ flash('No encuentro el campo DNI en esta página. ¿Estás en el formulario de inscripción?', '#b91c1c'); return; }
    input.focus();
    setNativeValue(input, dni);
    flash('DNI escrito: ' + dni, '#15803d');
    if(estado.autoComprobar){
      const btn = findComprobarBtn();
      // pequeño retardo para que la web procese el valor antes de comprobar
      if(btn){ setTimeout(()=>{ try{ btn.click(); }catch(_){ } }, 400); }
      else flash('DNI escrito, pero no encuentro el botón "Comprobar" — púlsalo tú.', '#b45309');
    }
  }

  function siguiente(){
    if(estado.idx < estado.dnis.length - 1){ estado.idx++; guardar(); render(); }
    else { estado.idx = estado.dnis.length; guardar(); render(); }
  }
  function anterior(){ if(estado.idx > 0){ estado.idx--; guardar(); render(); } }

  function cargarLista(texto){
    const dnis = (texto||'')
      .split(/[\s,;]+/)
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);
    estado.dnis = dnis; estado.idx = 0; guardar(); render();
    flash(dnis.length + ' DNIs cargados.', '#15803d');
  }

  // ── UI ──
  let panel;
  function flash(msg, color){
    const s = document.getElementById('fccvAsisStatus');
    if(s){ s.textContent = msg; s.style.color = color || '#334155'; }
  }
  function render(){
    if(!panel) return;
    const n = estado.dnis.length;
    const done = estado.idx >= n;
    const cur = done ? '—' : estado.dnis[estado.idx];
    panel.querySelector('#fccvAsisProg').textContent = n ? (done ? `✅ ${n}/${n} completados` : `Corredor ${estado.idx+1} de ${n}`) : 'Sin lista cargada';
    panel.querySelector('#fccvAsisCur').textContent = cur;
    panel.querySelector('#fccvAsisAuto').checked = !!estado.autoComprobar;
  }

  function construirPanel(){
    panel = document.createElement('div');
    panel.id = 'fccvAsisPanel';
    panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:300px;background:#fff;border:2px solid #0b2f6b;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.3);font-family:system-ui,Arial,sans-serif;font-size:13px;color:#0b2f6b';
    panel.innerHTML = `
      <div style="background:#0b2f6b;color:#fff;padding:9px 12px;border-radius:9px 9px 0 0;display:flex;align-items:center;justify-content:space-between;cursor:default">
        <b>🏷️ Asistente inscripción FCCV</b>
        <span id="fccvAsisMin" title="Ocultar/mostrar" style="cursor:pointer;font-weight:900">▾</span>
      </div>
      <div id="fccvAsisBody" style="padding:12px">
        <textarea id="fccvAsisInput" rows="3" placeholder="Pega aquí los DNIs (uno por línea, desde el botón 'Copiar todos los DNI' de tu app)" style="width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:7px;font-size:12px;resize:vertical"></textarea>
        <button id="fccvAsisLoad" style="width:100%;margin-top:6px;background:#1a56db;color:#fff;border:0;border-radius:8px;padding:8px;font-weight:800;cursor:pointer">📋 Cargar lista</button>
        <div style="border-top:1px dashed #cbd5e1;margin:10px 0;padding-top:10px">
          <div id="fccvAsisProg" style="font-weight:800;font-size:12px;color:#475569">Sin lista cargada</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px">DNI actual:</div>
          <div id="fccvAsisCur" style="font-family:monospace;font-size:20px;font-weight:900;letter-spacing:1px;color:#15803d">—</div>
        </div>
        <button id="fccvAsisFill" style="width:100%;background:#15803d;color:#fff;border:0;border-radius:8px;padding:10px;font-weight:800;cursor:pointer">✏️ Rellenar este DNI</button>
        <div style="display:flex;gap:6px;margin-top:6px">
          <button id="fccvAsisPrev" style="flex:1;background:#f1f5f9;color:#475569;border:0;border-radius:8px;padding:7px;font-weight:700;cursor:pointer">◀ Anterior</button>
          <button id="fccvAsisNext" style="flex:1;background:#0b2f6b;color:#fff;border:0;border-radius:8px;padding:7px;font-weight:800;cursor:pointer">Siguiente ▶</button>
        </div>
        <label style="display:flex;align-items:center;gap:6px;margin-top:9px;font-size:11.5px;color:#475569;cursor:pointer">
          <input type="checkbox" id="fccvAsisAuto"> Pulsar "Comprobar" automáticamente
        </label>
        <div id="fccvAsisStatus" style="margin-top:8px;font-size:11.5px;min-height:16px"></div>
        <div style="font-size:10px;color:#94a3b8;margin-top:6px;line-height:1.4">Tras "Comprobar", completa lo que pida la FCCV y pulsa <b>Siguiente</b>. La lista se conserva aunque la página recargue.</div>
      </div>`;
    document.body.appendChild(panel);

    panel.querySelector('#fccvAsisLoad').onclick = ()=> cargarLista(panel.querySelector('#fccvAsisInput').value);
    panel.querySelector('#fccvAsisFill').onclick = rellenarActual;
    panel.querySelector('#fccvAsisNext').onclick = siguiente;
    panel.querySelector('#fccvAsisPrev').onclick = anterior;
    panel.querySelector('#fccvAsisAuto').onchange = (e)=>{ estado.autoComprobar = e.target.checked; guardar(); };
    panel.querySelector('#fccvAsisMin').onclick = ()=>{
      const b = panel.querySelector('#fccvAsisBody');
      b.style.display = b.style.display==='none' ? '' : 'none';
    };
    render();
  }

  cargar(()=>{ construirPanel(); });
})();
