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

    // ── ¿Qué parte del iframe se ve de verdad? ──
    // Muestrea puntos verticales sobre el iframe con elementFromPoint y
    // se queda con el TRAMO LIBRE MÁS GRANDE (donde el punto devuelve el
    // propio iframe). No vale el primer punto libre: el menú sticky del
    // sitio deja un pequeño hueco por encima y la ficha acabaría ahí,
    // con los botones de cerrar escondidos detrás del menú.
    var PASO = 8;
    function zonaVisible(r) {
      var x = Math.max(1, Math.min(window.innerWidth - 2, r.left + r.width / 2));
      var maxY = Math.min(r.bottom, window.innerHeight);
      var y0 = Math.max(r.top, 0);
      var ys = [], vis = [];
      for (var y = y0 + 2; y < maxY; y += PASO) {
        ys.push(y);
        vis.push(document.elementFromPoint(x, y) === iframe);
      }
      var mejorIni = -1, mejorFin = -1, ini = -1;
      for (var i = 0; i <= vis.length; i++) {
        if (i < vis.length && vis[i]) {
          if (ini < 0) ini = i;
        } else if (ini >= 0) {
          if (mejorIni < 0 || ys[i - 1] - ys[ini] > ys[mejorFin] - ys[mejorIni]) {
            mejorIni = ini;
            mejorFin = i - 1;
          }
          ini = -1;
        }
      }
      if (mejorIni < 0) return { top: y0, alto: maxY - y0 };
      return { top: ys[mejorIni] - 2, alto: ys[mejorFin] - ys[mejorIni] + PASO };
    }

    function avisarVista() {
      if (!iframe.contentWindow) return;
      var r = iframe.getBoundingClientRect();
      if (r.height === 0) return;
      var zona = zonaVisible(r);
      iframe.contentWindow.postMessage(
        { tipo: 'mfpp-rp-vista', top: Math.round(zona.top - r.top), alto: Math.round(zona.alto) },
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
