# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this repo is

A static site hosted on **Netlify** (`clasificaciones-director.netlify.app`, custom domain `ranking.mfppcycling.com`) with a **Supabase** backend. It contains **two independent front-ends plus a build-time SEO generator**:

1. **Admin dashboard** — `index.html` + `assets/js/app.js` (~48k lines) + `assets/css/styles.css`. The internal tool the director uses to manage race data. Authenticates with Supabase and **reads/writes**.
2. **Public ranking widget** — `ranking/ranking-publico.{html,js,css}`. A **read-only** public ranking embedded via `<iframe>` in the WordPress site `mfppcycling.com/ranking`. Fetches from Supabase with the **anon key only** and does `.select()` **only** — never insert/update/delete, never `service_role` (enforced by convention; see the header comment in `ranking-publico.js`). `ranking/embed.js` is the script `mfppcycling.com` loads; it drives an iframe height/viewport `postMessage` protocol (`mfpp-rp-altura` / `mfpp-rp-vista`).
3. **SEO static generator** — `build-seo.js` + `ranking-core.js`. At build time, reads Supabase and emits static, indexable pages under `dist/ranking/resultados/` (hub + one per race + one general-ranking page per category + `sitemap.xml`, with `SportsEvent`/`ItemList`/`CollectionPage` JSON-LD). These are served on the SEO subdomain.

**Two URLs, two purposes:** `mfppcycling.com/ranking` = the interactive iframe widget (for people); `ranking.mfppcycling.com` = the static SEO pages (for Google). `_redirects` sends the subdomain root to `/ranking/resultados/` without affecting the `netlify.app` admin.

## Commands

- **Build:** `node build.js` (or `npm run build`) → writes everything to `dist/` (gitignored). This is what Netlify runs (`netlify.toml`), publishing `dist/`.
- **Develop the admin dashboard:** `npm run dev` (opens `index.html`).
- **Develop the ranking widget:** open `ranking/ranking-publico.html` directly — it fetches live data from Supabase, so no build step is needed to iterate; `build.js` only adds cache-busting for production.
- **Deploy:** push to git; Netlify auto-builds (`node build.js`) and publishes `dist/`.
- There is **no test suite and no linter** configured.

Developing the widget or SEO pages requires Supabase to be reachable (data is fetched at runtime / build time).

## Critical constraints (non-obvious, easy to break)

- **The scoring engine lives in two places that must stay in sync by hand.** `ranking/ranking-publico.js` (browser, the source of truth) and `ranking-core.js` (a CommonJS port used by `build-seo.js`). Both share the `RP_*` constants (`RP_PUNTOS_BASE`, `RP_PUNTOS_ETAPA`, `RP_COEFICIENTES`, `RP_COEF_PARTICIPACION`, `RP_BONO_FINALIZAR`, `RP_MAX_RESULTADOS_CONTADOS`, …) and `rp*` functions. **If you change scoring, change both**, and verify the SEO pages' numbers match the widget exactly.
- **The ranking widget is read-only.** Only `.select()`; never write; anon key only. This is a security boundary (the embed must never carry an admin session).
- **`build.js` copies only the 3 widget files** (`ranking-publico.{html,js,css}`) plus `ranking/banderas/` and `embed.js` — **never `ranking/backups/`**.
- **SEO generation is non-fatal.** `build.js` runs `build-seo.generarSEO()` in a try/catch; a Supabase outage must not break the deploy (the widget and admin don't depend on it).
- **Cache-busting by content hash.** `build.js` appends `?v=<md5>` to CSS/JS URLs. `netlify.toml`/`_headers` then set HTML to `no-cache` but versioned `/assets/*` and `/ranking/banderas/*` to `immutable` for a year. `embed.js` is served without `?v=` (stable URL, no-cache) so WordPress never needs editing.
- **CSP restricts embedding.** `/ranking/*` is only iframe-embeddable from `mfppcycling.com` (`frame-ancestors` in `netlify.toml`).
- Supabase project/anon key are hardcoded in `ranking-core.js`, `build-seo.js`, and `ranking-publico.js` (`RP_SUPABASE_URL`/`RP_SUPABASE_ANON_KEY`). `build-seo.js` also defines `BASE` (SEO subdomain), `WEB` (main site), and `TEMPORADA`.

## Ancillary directories

- `backups-web/` — static HTML backups of the 6 hand-coded pages of the WordPress site (`mfppcycling.com`), for recovery. Not part of the app.
- `extension-fccv/` — a browser extension (separate `manifest.json`).
- `fccv-calibration/`, `migracion-auth/` — PDFs and SQL snippets; auxiliary, not built.
- `backups/`, `dist/`, `node_modules/`, `.netlify` — gitignored.
