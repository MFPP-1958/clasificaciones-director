# Cómo escribir en WordPress (mfppcycling.com) por API — SÍ funciona

> Comprobado el 19/07/2026: `GET /wp-json/wp/v2/users/me` devuelve **HTTP 200** autenticado como `mfppmfpp` (id 1).
> Por esta vía se han creado entradas, páginas, se han subido imágenes y se ha reordenado el menú.
> **El hosting NO bloquea la escritura por API.** Lo que sí puede estar bloqueado es FTP/SSH o editar ficheros del theme; eso es otra cosa.

## 1. Método

**WordPress REST API + Application Password (autenticación básica HTTP).**
No hace falta plugin: las *Application Passwords* son parte del núcleo de WordPress desde la 5.6. No se usa XML-RPC ni la contraseña normal del usuario.

## 2. Credenciales

Están en `/Users/manuelfrancisperezperez/Desktop/Redes Sociales/.env` (permisos 600):

```
WP_URL=https://mfppcycling.com
WP_USER=mfppmfpp
WP_APP_PASSWORD=<la contraseña de aplicación, con espacios incluidos>
```

Ojo al leer ese `.env`: algunas líneas usan `:` como separador en vez de `=`. Conviene partir por el primero de los dos.
La contraseña de aplicación lleva espacios; se envía **tal cual**, sin quitarlos.

## 3. Comprobación en 5 segundos

```python
import requests
r = requests.get("https://mfppcycling.com/wp-json/wp/v2/users/me",
                 auth=("mfppmfpp", "xxxx xxxx xxxx xxxx xxxx xxxx"), timeout=30)
print(r.status_code, r.json().get("name"))   # -> 200 mfppmfpp
```

Si sale 401, la contraseña de aplicación es incorrecta o está revocada.

## 4. Operaciones habituales

```python
import requests
AUTH = ("mfppmfpp", "<app password>")
WP   = "https://mfppcycling.com"

# --- Crear una PÁGINA con código HTML (bloque "HTML personalizado")
html = open("mi_widget.html", encoding="utf-8").read()
requests.post(WP + "/wp-json/wp/v2/pages", auth=AUTH, timeout=90, json={
    "title": "Calendario",
    "slug": "calendario",
    "content": "<!-- wp:html -->\n" + html + "\n<!-- /wp:html -->",
    "status": "publish",          # o "draft"
})

# --- Actualizar una página/entrada existente (id conocido)
requests.post(WP + "/wp-json/wp/v2/pages/5646", auth=AUTH, json={"content": nuevo_html})

# --- Buscar por título
requests.get(WP + "/wp-json/wp/v2/pages", auth=AUTH,
             params={"search": "Calendario", "status": "any", "per_page": 20})

# --- Subir una imagen a la biblioteca
ruta = "imagen.png"
requests.post(WP + "/wp-json/wp/v2/media", auth=AUTH, timeout=120,
    headers={"Content-Disposition": 'attachment; filename="imagen.png"',
             "Content-Type": "image/png"},
    data=open(ruta, "rb").read())

# --- Crear una ENTRADA de blog con SEO de Yoast
requests.post(WP + "/wp-json/wp/v2/posts", auth=AUTH, json={
    "title": "Título", "slug": "slug-seo", "content": "<p>...</p>",
    "excerpt": "resumen", "status": "draft",
    "featured_media": 1234, "categories": [12],
    "meta": {"_yoast_wpseo_metadesc": "...", "_yoast_wpseo_focuskw": "..."},
})

# --- Menús (WP 5.9+)
requests.get(WP + "/wp-json/wp/v2/menus", auth=AUTH)          # id 4 = "Menú principal"
requests.get(WP + "/wp-json/wp/v2/menu-items", auth=AUTH, params={"menus": 4, "per_page": 100})
requests.post(WP + "/wp-json/wp/v2/menu-items", auth=AUTH, json={
    "title": "Calendario", "menus": 4, "type": "post_type",
    "object": "page", "object_id": 5646, "status": "publish"})
# reordenar: POST a /menu-items/<id> con {"menu_order": N, "parent": P, "menus": 4}
```

## 5. Trampas REALES de este sitio (aprendidas a base de fallos)

### 5.1. WordPress destroza los `&` sueltos del JavaScript ⚠️
Al guardar el contenido, WordPress convierte cualquier `&` que **no** forme parte de una entidad válida en `&#038;`.
Resultado: `if(a && b)` llega al navegador como `if(a &#038;&#038; b)` → **`Uncaught SyntaxError: Invalid or unexpected token`** y el script muere entero.

**Regla: en JS incrustado no puede haber ni un solo `&` suelto.**
- `if(a && b) return false;` → `if(a){ if(b) return false; }`
- En cadenas de texto: usa el escape `&` (`"?select=*&order=fecha.asc"`).
- Las entidades válidas (`&oacute;`, `&middot;`, `&#8599;`) **sí** se respetan; esas no dan problema.

Comprobación antes de publicar:
```python
import re
assert not re.findall(r'&(?!#?\w+;)', html), "hay & sueltos: romperán el JS"
```

### 5.2. LiteSpeed Cache aplaza los scripts ⚠️
El plugin reescribe los `<script>` como `type="litespeed/javascript"` y el navegador **no los ejecuta**.

**Solución:** añadir atributos a cada `<script>` del bloque:
```html
<script data-no-optimize="1" data-no-defer="1" data-cfasync="false">
```

### 5.3. Elementor sobrescribe las páginas de código
Las páginas creadas por API con bloque HTML **no** se deben abrir con "Editar con Elementor": lo machaca. Editar solo por API o con el editor de bloques.

### 5.4. Verifica siempre el resultado servido, no lo que has enviado
Lo que guardas y lo que el navegador recibe pueden diferir (WordPress + LiteSpeed por medio). Flujo recomendado:
```python
h = requests.get("https://mfppcycling.com/pagina/?v=" + str(int(time.time()))).text  # cache-buster
# extraer el <script> del bloque y validarlo:
#   node --check script.js
# y comprobar:  "&#038;" no aparece  y  "litespeed/javascript" no aparece
```

## 6. Referencia rápida de este sitio

| Dato | Valor |
|---|---|
| Página "Calendario" | id **5646** → https://mfppcycling.com/calendario/ |
| Menú principal | id **4** (`primary`) |
| Categorías del blog | Entrenamientos 11 · Fisiología 12 · Nutrición 13 · Últimas noticias 29 · Material 31 · Psicología 32 · Biomecánica 33 · Salud 34 |
| Stack | Astra + Elementor + LiteSpeed Cache + Yoast |
