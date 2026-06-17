/* ════════════════════════════════════════════════════════════════════════
   Asistente de inscripción FCCV · TBG-WIXUM  (v1.1)
   ────────────────────────────────────────────────────────────────────────
   Panel flotante en fccv.es para rellenar los DNI del formulario UNO A UNO.
   Muestra NOMBRE + DNI, marca los YA INSCRITOS (✓) para no repetir, y
   conserva el estado aunque la página recargue (chrome.storage.local).
   El director da el clic de "Comprobar" e "Inscribir" (controla consentimientos).
   ════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  if(window.__fccvAsistenteCargado) return;
  window.__fccvAsistenteCargado = true;

  const KEY = 'fccv_asistente_estado_v2';
  // items: [{name, dni, done}]
  let estado = { items: [], idx: 0, autoComprobar: false };

  function guardar(){ try{ chrome.storage.local.set({ [KEY]: estado }); }catch(_){ } }
  function cargar(cb){
    try{ chrome.storage.local.get(KEY, r=>{ if(r && r[KEY]) estado = Object.assign(estado, r[KEY]); cb(); }); }
    catch(_){ cb(); }
  }

  // ── Parsear lista pegada: admite "Nombre | DNI", "Nombre<TAB>DNI" o solo DNI ──
  function parseLista(texto){
    const items = [];
    (texto||'').split(/\r?\n/).forEach(line=>{
      const t = line.trim(); if(!t) return;
      let name='', dni='';
      const m = t.split(/\s*[|\t]\s*/);
      if(m.length >= 2){ name = m[0].trim(); dni = m[m.length-1].trim(); }
      else { dni = t; }
      dni = dni.toUpperCase().replace(/\s+/g,'');
      if(dni) items.push({ name: name || '(sin nombre)', dni, done:false });
    });
    return items;
  }

  // ── Localizar campo DNI y botón Comprobar (robusto, sin id fijo) ──
  function findDniInput(){
    let el = document.querySelector('input[placeholder="DNI"]') ||
             document.querySelector('input[placeholder*="dni" i]');
    if(el) return el;
    const nodes = [...document.querySelectorAll('label,td,th,div,span,b,strong')]
      .filter(n => /dni\s*\/\s*id|n[uú]mero de dni|\bdni\b/i.test(n.textContent||''));
    for(const n of nodes){
      const cont = n.closest('tr,div,form,table') || n.parentElement;
      const inp = cont && cont.querySelector('input[type=text], input:not([type])');
      if(inp) return inp;
    }
    return [...document.querySelectorAll('input[type=text], input:not([type])')]
      .find(i => i.offsetParent !== null) || null;
  }
  function findComprobarBtn(){
    const cands = [...document.querySelectorAll('button, input[type=submit], input[type=button], a')];
    return cands.find(b => /comprobar/i.test((b.textContent||'') + ' ' + (b.value||''))) || null;
  }
  function setNativeValue(el, val){
    try{
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
    }catch(_){ el.value = val; }
    el.dispatchEvent(new Event('input',  { bubbles:true }));
    el.dispatchEvent(new Event('change', { bubbles:true }));
  }

  function curItem(){ return estado.items[estado.idx]; }

  function rellenarActual(){
    const it = curItem();
    if(!it){ flash('No hay ningún corredor seleccionado.', '#b45309'); return; }
    const input = findDniInput();
    if(!input){ flash('No encuentro el campo DNI. ¿Estás en el formulario de inscripción?', '#b91c1c'); return; }
    input.focus();
    setNativeValue(input, it.dni);
    flash('DNI escrito: ' + it.dni + (it.name!=='(sin nombre)' ? ' · '+it.name : ''), '#15803d');
    if(estado.autoComprobar){
      const btn = findComprobarBtn();
      if(btn){ setTimeout(()=>{ try{ btn.click(); }catch(_){ } }, 400); }
      else flash('DNI escrito, pero no veo "Comprobar" — púlsalo tú.', '#b45309');
    }
  }

  function marcarInscrito(){
    const it = curItem();
    if(it){ it.done = true; }
    // saltar al siguiente NO inscrito
    let next = estado.items.findIndex((x,i)=> i>estado.idx && !x.done);
    if(next === -1) next = estado.items.findIndex(x=>!x.done);
    estado.idx = next === -1 ? estado.items.length : next;
    guardar(); render();
  }
  function irA(i){ estado.idx = i; guardar(); render(); }

  function cargarLista(texto){
    estado.items = parseLista(texto); estado.idx = 0; guardar(); render();
    flash(estado.items.length + ' corredores cargados.', '#15803d');
  }
  function reiniciarMarcas(){
    estado.items.forEach(x=>x.done=false); estado.idx=0; guardar(); render();
  }

  // ── UI ──
  let panel;
  function flash(msg, color){
    const s = document.getElementById('fccvAsisStatus');
    if(s){ s.textContent = msg; s.style.color = color || '#334155'; }
  }
  function render(){
    if(!panel) return;
    const items = estado.items, n = items.length;
    const doneN = items.filter(x=>x.done).length;
    const it = curItem();
    panel.querySelector('#fccvAsisProg').textContent = n ? `${doneN}/${n} inscritos` : 'Sin lista cargada';
    panel.querySelector('#fccvAsisCurName').textContent = it ? (it.name!=='(sin nombre)'?it.name:'—') : '✅ Todos inscritos';
    panel.querySelector('#fccvAsisCur').textContent = it ? it.dni : '—';
    panel.querySelector('#fccvAsisAuto').checked = !!estado.autoComprobar;
    // Lista con estado
    const lst = panel.querySelector('#fccvAsisList');
    lst.innerHTML = items.map((x,i)=>{
      const mark = x.done ? '✅' : (i===estado.idx ? '▶️' : '⬜');
      const bg = i===estado.idx ? '#eff6ff' : (x.done ? '#f0fdf4' : '#fff');
      const col = x.done ? '#15803d' : '#0b2f6b';
      return `<div data-i="${i}" class="fccv-row" style="display:flex;align-items:center;gap:6px;padding:5px 7px;border-radius:6px;background:${bg};cursor:pointer;font-size:12px;color:${col}">
        <span>${mark}</span>
        <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${x.name!=='(sin nombre)'?x.name:''}</span>
        <span style="font-family:monospace;font-size:11px;color:#64748b">${x.dni}</span>
      </div>`;
    }).join('');
    lst.querySelectorAll('.fccv-row').forEach(row=>{
      row.onclick = ()=> irA(parseInt(row.dataset.i));
    });
  }

  function construirPanel(){
    panel = document.createElement('div');
    panel.id = 'fccvAsisPanel';
    panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:320px;background:#fff;border:2px solid #0b2f6b;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.3);font-family:system-ui,Arial,sans-serif;font-size:13px;color:#0b2f6b';
    panel.innerHTML = `
      <div style="background:#0b2f6b;color:#fff;padding:9px 12px;border-radius:9px 9px 0 0;display:flex;align-items:center;justify-content:space-between">
        <b>🏷️ Asistente inscripción FCCV</b>
        <span id="fccvAsisMin" title="Ocultar/mostrar" style="cursor:pointer;font-weight:900">▾</span>
      </div>
      <div id="fccvAsisBody" style="padding:12px;max-height:78vh;overflow:auto">
        <textarea id="fccvAsisInput" rows="3" placeholder="Pega aquí 'Nombre | DNI' (botón 'Copiar para el asistente' de tu app). También vale solo DNIs." style="width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:7px;font-size:12px;resize:vertical"></textarea>
        <button id="fccvAsisLoad" style="width:100%;margin-top:6px;background:#1a56db;color:#fff;border:0;border-radius:8px;padding:8px;font-weight:800;cursor:pointer">📋 Cargar lista</button>
        <div style="border-top:1px dashed #cbd5e1;margin:10px 0;padding-top:10px">
          <div id="fccvAsisProg" style="font-weight:800;font-size:12px;color:#475569">Sin lista cargada</div>
          <div id="fccvAsisCurName" style="font-weight:800;font-size:14px;margin-top:3px">—</div>
          <div id="fccvAsisCur" style="font-family:monospace;font-size:20px;font-weight:900;letter-spacing:1px;color:#15803d">—</div>
        </div>
        <button id="fccvAsisFill" style="width:100%;background:#15803d;color:#fff;border:0;border-radius:8px;padding:10px;font-weight:800;cursor:pointer">✏️ Rellenar este DNI</button>
        <button id="fccvAsisDone" style="width:100%;margin-top:6px;background:#0b2f6b;color:#fff;border:0;border-radius:8px;padding:9px;font-weight:800;cursor:pointer">✅ Marcar inscrito y siguiente</button>
        <label style="display:flex;align-items:center;gap:6px;margin-top:9px;font-size:11.5px;color:#475569;cursor:pointer">
          <input type="checkbox" id="fccvAsisAuto"> Pulsar "Comprobar" automáticamente
        </label>
        <div id="fccvAsisStatus" style="margin-top:8px;font-size:11.5px;min-height:16px"></div>
        <div style="border-top:1px dashed #cbd5e1;margin:10px 0 6px;padding-top:8px;display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:11px;font-weight:800;color:#475569">Lista (clic para ir a uno)</span>
          <span id="fccvAsisReset" title="Quitar todas las marcas de inscrito" style="font-size:10.5px;color:#b45309;cursor:pointer;text-decoration:underline">reiniciar marcas</span>
        </div>
        <div id="fccvAsisList" style="display:flex;flex-direction:column;gap:3px;max-height:200px;overflow:auto"></div>
        <div style="font-size:10px;color:#94a3b8;margin-top:8px;line-height:1.4">⚠️ En el PASO 2, revisa los consentimientos (la 2ª casilla es de promoción comercial, puedes desmarcarla) y pulsa <b>Inscribir</b> tú. Luego <b>Marcar inscrito</b>.</div>
      </div>`;
    document.body.appendChild(panel);

    panel.querySelector('#fccvAsisLoad').onclick = ()=> cargarLista(panel.querySelector('#fccvAsisInput').value);
    panel.querySelector('#fccvAsisFill').onclick = rellenarActual;
    panel.querySelector('#fccvAsisDone').onclick = marcarInscrito;
    panel.querySelector('#fccvAsisAuto').onchange = (e)=>{ estado.autoComprobar = e.target.checked; guardar(); };
    panel.querySelector('#fccvAsisReset').onclick = ()=>{ if(confirm('¿Quitar todas las marcas de inscrito?')) reiniciarMarcas(); };
    panel.querySelector('#fccvAsisMin').onclick = ()=>{
      const b = panel.querySelector('#fccvAsisBody');
      b.style.display = b.style.display==='none' ? '' : 'none';
    };
    render();
  }

  cargar(()=>{ construirPanel(); });
})();
