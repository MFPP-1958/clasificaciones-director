/* ============================================================
   RANKING PÚBLICO — script del lado de la web (mfppcycling.com)
   Se carga desde la página Ranking de WordPress con:
     <script src="https://clasificaciones-director.netlify.app/ranking/embed.js" defer></script>
   Al vivir en Netlify (y servirse sin caché), cualquier mejora se
   despliega sola: no hay que volver a tocar el bloque de WordPress.

   Qué hace:
   1) Escucha 'mfpp-rp-altura' del iframe y le da esa altura: una sola
      barra de scroll (la de la página), sin scroll interno en móvil.
   2) Envía 'mfpp-rp-vista' (top/alto de la zona realmente visible,
      descontando menús fijos) para que la ficha modal del corredor se
      abra siempre a la vista. La zona tapada por barras fijas se mide
      con elementFromPoint: funciona con cualquier tema (Astra,
      Elementor...) sin depender de selectores concretos.
   Solo se intercambian números (alturas/posiciones), nunca datos.
   ============================================================ */

(function () {
  'use strict';

  var ORIGEN = 'https://clasificaciones-director.netlify.app';

  function init() {
    var iframe = document.getElementById('mfpp-ranking-iframe');
    if (!iframe) return;

    // ── Altura del contenido → altura del iframe ──
    window.addEventListener('message', function (ev) {
      if (ev.origin !== ORIGEN || !ev.data || ev.data.tipo !== 'mfpp-rp-altura') return;
      iframe.style.height = ev.data.altura + 'px';
      programarVista();
    });

    // ── ¿Dónde empieza la parte del iframe que se ve de verdad? ──
    // Recorre puntos verticales sobre el iframe; el primero en el que
    // elementFromPoint devuelve el propio iframe no está tapado por
    // ninguna barra fija (menú sticky, barra de admin, avisos...).
    function topeVisible(r) {
      var x = Math.max(1, Math.min(window.innerWidth - 2, r.left + r.width / 2));
      var maxY = Math.min(r.bottom, window.innerHeight);
      var y0 = Math.max(r.top, 0);
      for (var y = y0 + 1; y < maxY; y += 10) {
        if (document.elementFromPoint(x, y) === iframe) return y;
      }
      return y0;
    }

    function avisarVista() {
      if (!iframe.contentWindow) return;
      var r = iframe.getBoundingClientRect();
      if (r.height === 0) return;
      var tope = topeVisible(r);
      var alto = Math.min(r.bottom, window.innerHeight) - tope;
      iframe.contentWindow.postMessage(
        { tipo: 'mfpp-rp-vista', top: Math.round(tope - r.top), alto: Math.round(alto) },
        ORIGEN
      );
    }

    // Agrupa ráfagas de scroll/resize en un solo aviso por fotograma.
    var pendiente = false;
    function programarVista() {
      if (pendiente) return;
      pendiente = true;
      requestAnimationFrame(function () {
        pendiente = false;
        avisarVista();
      });
    }

    window.addEventListener('scroll', programarVista, { passive: true });
    window.addEventListener('resize', programarVista);
    iframe.addEventListener('load', programarVista);

    // Reintentos iniciales: fuentes, lazy-load del iframe (LiteSpeed) y
    // reordenaciones tardías del tema pueden mover las cosas al arrancar.
    programarVista();
    setTimeout(programarVista, 800);
    setTimeout(programarVista, 2500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
