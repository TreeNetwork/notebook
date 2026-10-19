# Notebook — Leila's personal Notion replacement

One Cloudflare Worker (API + UI), D1 for data. No framework, no build step.

- **Live D1:** `notebook`, id `cd5d7fac-05d4-45da-8f9a-d35fccf72239` (schema already created — sessions, pages, db_rows). Separate from all Tree+ databases.
- **Secret required:** `ACCESS_PASSPHRASE` (set in Cloudflare dashboard → the Worker → Settings → Variables and Secrets). Login won't work until it's set.
- **Deploy:** GitHub repo connected to Cloudflare Workers Builds — push = deploy.
- **Data rules:** pages are never hard-deleted (archive only); database rows can be deleted from the UI with a confirm.
- **Import:** sidebar → "Import Notion export (.zip)" takes Notion's *Export → Markdown & CSV* zip (works best with subpages included). Markdown → pages, CSV → databases; the top-level "Export…" wrapper folder is skipped.

Files:
- `wrangler.toml` — load-bearing config (D1 binding, assets dir). Don't change the database_id.
- `worker.js` — API, auth, Notion-zip importer.
- `public/index.html` — the whole UI.
