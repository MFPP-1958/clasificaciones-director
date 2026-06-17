# Asistente de inscripción FCCV (extensión Chrome)

Rellena los DNI en el formulario de inscripción de **fccv.es** uno a uno, sin
teclear. **Tú das el clic de "Comprobar"** (acto oficial bajo tu control).

## Qué hace
- Aparece como un **panel flotante** (abajo a la derecha) cuando estás en fccv.es.
- Pegas la lista de DNIs (del botón **"📋 Copiar todos los DNI"** del Dashboard).
- Para cada corredor: **✏️ Rellenar este DNI** → escribe el DNI en el campo →
  pulsas **Comprobar** (o marca la casilla para que lo pulse solo) → completas lo
  que pida la FCCV → **Siguiente ▶**.
- Guarda por dónde vas aunque la página recargue.

## Cómo instalarla (una vez)
1. Abre Chrome → menú **⋮ → Extensiones → Gestionar extensiones**
   (o escribe `chrome://extensions` en la barra).
2. Arriba a la derecha, activa **"Modo de desarrollador"**.
3. Pulsa **"Cargar descomprimida"** (Load unpacked).
4. Selecciona esta carpeta **`extension-fccv`**.
5. Listo: cuando entres en fccv.es verás el panel.

## Cómo usarla
1. En el Dashboard: Disponibilidad → **🏷️ Inscripción FCCV** → **📋 Copiar todos los DNI**.
2. En fccv.es: ve a la prueba → **Deportistas → Inscripción**.
3. En el panel flotante: pega los DNIs → **Cargar lista**.
4. **Rellenar este DNI** → Comprobar → completa → **Siguiente**. Repite.

## Notas honestas
- **Depende del formulario de la FCCV**: si cambian su web, habrá que ajustar
  los selectores en `content.js` (funciones `findDniInput` / `findComprobarBtn`).
- No envía datos a ningún sitio: todo es local en tu navegador.
- Mantén el clic final en tu mano para no inscribir a nadie por error.
