// Notebook — one Worker: API + static UI. Plain JS, no build step.
// Auth: passphrase (env.ACCESS_PASSPHRASE) -> session cookie backed by D1.
// Data: pages (tree; kind 'page' or 'database'), db_rows (database rows).
// Import: accepts a Notion "Markdown & CSV" export zip.

const COOKIE = 'nb_session';
const YEAR = 60 * 60 * 24 * 365;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env, url);
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  }
};

/* ---------------- helpers ---------------- */

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  });
}
function getCookie(request, name) {
  const c = request.headers.get('cookie') || '';
  for (const part of c.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}
function newId() { return crypto.randomUUID().replace(/-/g, '').slice(0, 20); }
function now() { return Date.now(); }

async function requireAuth(request, env) {
  const token = getCookie(request, COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare('SELECT token FROM sessions WHERE token=?').bind(token).first();
  return row ? token : null;
}

/* ---------------- API router ---------------- */

async function api(request, env, url) {
  const path = url.pathname.replace(/^\/api/, '');
  const method = request.method;

  if (path === '/login' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const pass = String(body.passphrase || '');
    const want = String(env.ACCESS_PASSPHRASE || '');
    if (!want) return json({ error: 'ACCESS_PASSPHRASE is not set on the Worker yet.' }, 500);
    // constant-time-ish compare
    const a = new TextEncoder().encode(pass), b = new TextEncoder().encode(want);
    let ok = a.length === b.length ? 1 : 0;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) ok &= (a[i % (a.length || 1)] === b[i % (b.length || 1)]) ? 1 : 0;
    if (!ok) return json({ error: 'Wrong passphrase.' }, 401);
    const token = crypto.randomUUID() + crypto.randomUUID();
    await env.DB.prepare('INSERT INTO sessions (token, created) VALUES (?,?)').bind(token, now()).run();
    return json({ ok: true }, 200, {
      'set-cookie': `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${YEAR}`
    });
  }

  const auth = await requireAuth(request, env);
  if (path === '/me' && method === 'GET') return json({ authed: !!auth });
  if (!auth) return json({ error: 'Not logged in.' }, 401);

  if (path === '/logout' && method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(auth).run();
    return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0` });
  }

  if (path === '/tree' && method === 'GET') {
    const q = await env.DB.prepare(
      'SELECT id,parent_id,title,kind,sort,archived FROM pages ORDER BY sort,created'
    ).all();
    return json({ pages: q.results });
  }

  if (path === '/pages' && method === 'POST') {
    const b = await request.json();
    const id = newId(), t = now();
    const kind = b.kind === 'database' ? 'database' : 'page';
    const fields = kind === 'database'
      ? JSON.stringify([{ name: 'Name', type: 'text' }])
      : '[]';
    const maxs = await env.DB.prepare('SELECT MAX(sort) m FROM pages WHERE parent_id IS ?')
      .bind(b.parent_id || null).first();
    await env.DB.prepare(
      'INSERT INTO pages (id,parent_id,title,kind,content,fields_json,sort,archived,created,updated) VALUES (?,?,?,?,?,?,?,0,?,?)'
    ).bind(id, b.parent_id || null, b.title || 'Untitled', kind, '', fields, ((maxs && maxs.m) || 0) + 1, t, t).run();
    return json({ id });
  }

  let m;
  if ((m = path.match(/^\/pages\/([A-Za-z0-9]+)$/))) {
    const id = m[1];
    if (method === 'GET') {
      const page = await env.DB.prepare('SELECT * FROM pages WHERE id=?').bind(id).first();
      if (!page) return json({ error: 'Not found' }, 404);
      let rows = [];
      if (page.kind === 'database') {
        const q = await env.DB.prepare('SELECT * FROM db_rows WHERE page_id=? ORDER BY sort,created').bind(id).all();
        rows = q.results;
      }
      return json({ page, rows });
    }
    if (method === 'PATCH') {
      const b = await request.json();
      const sets = [], vals = [];
      for (const k of ['title', 'content', 'fields_json', 'parent_id', 'sort', 'archived']) {
        if (k in b) { sets.push(k + '=?'); vals.push(b[k]); }
      }
      if (!sets.length) return json({ ok: true });
      sets.push('updated=?'); vals.push(now()); vals.push(id);
      await env.DB.prepare('UPDATE pages SET ' + sets.join(',') + ' WHERE id=?').bind(...vals).run();
      return json({ ok: true });
    }
    if (method === 'DELETE') { // archive, never hard-delete pages
      await env.DB.prepare('UPDATE pages SET archived=1, updated=? WHERE id=?').bind(now(), id).run();
      return json({ ok: true });
    }
  }

  if ((m = path.match(/^\/pages\/([A-Za-z0-9]+)\/rows$/)) && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const id = newId(), t = now();
    const maxs = await env.DB.prepare('SELECT MAX(sort) m FROM db_rows WHERE page_id=?').bind(m[1]).first();
    await env.DB.prepare('INSERT INTO db_rows (id,page_id,data_json,sort,created,updated) VALUES (?,?,?,?,?,?)')
      .bind(id, m[1], JSON.stringify(b.data || {}), ((maxs && maxs.m) || 0) + 1, t, t).run();
    return json({ id });
  }
  if ((m = path.match(/^\/rows\/([A-Za-z0-9]+)$/))) {
    if (method === 'PATCH') {
      const b = await request.json();
      await env.DB.prepare('UPDATE db_rows SET data_json=?, updated=? WHERE id=?')
        .bind(JSON.stringify(b.data || {}), now(), m[1]).run();
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM db_rows WHERE id=?').bind(m[1]).run();
      return json({ ok: true });
    }
  }

  if (path === '/tasks' && method === 'GET') {
    const q = await env.DB.prepare(
      "SELECT id,title,content FROM pages WHERE archived=0 AND kind='page' AND (content LIKE '%- [ ]%' OR content LIKE '%- [x]%')"
    ).all();
    const tasks = [];
    for (const p of q.results) {
      const lines = p.content.split('\n');
      lines.forEach((line, i) => {
        const t = line.match(/^\s*- \[( |x)\]\s*(.*)$/);
        if (t) tasks.push({ page_id: p.id, page_title: p.title, line: i, done: t[1] === 'x', text: t[2] });
      });
    }
    return json({ tasks });
  }
  if (path === '/tasks/toggle' && method === 'POST') {
    const b = await request.json();
    const page = await env.DB.prepare('SELECT content FROM pages WHERE id=?').bind(b.page_id).first();
    if (!page) return json({ error: 'Not found' }, 404);
    const lines = page.content.split('\n');
    const i = b.line | 0;
    if (i >= 0 && i < lines.length) {
      lines[i] = lines[i].replace(/^(\s*- \[)( |x)(\])/, (_, a, c, z) => a + (c === 'x' ? ' ' : 'x') + z);
      await env.DB.prepare('UPDATE pages SET content=?, updated=? WHERE id=?')
        .bind(lines.join('\n'), now(), b.page_id).run();
    }
    return json({ ok: true });
  }

  if (path === '/search' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return json({ results: [] });
    const like = '%' + q.replace(/[%_]/g, '') + '%';
    const r = await env.DB.prepare(
      'SELECT id,title,kind FROM pages WHERE archived=0 AND (title LIKE ? OR content LIKE ?) LIMIT 30'
    ).bind(like, like).all();
    return json({ results: r.results });
  }

  if (path === '/import' && method === 'POST') {
    const buf = await request.arrayBuffer();
    const report = await importNotionZip(buf, env);
    return json(report);
  }

  return json({ error: 'No such endpoint' }, 404);
}

/* ---------------- Notion zip import ---------------- */
// Reads the zip central directory, inflates entries with DecompressionStream,
// turns folders + .md files into nested pages and .csv files into databases.

async function importNotionZip(buf, env) {
  const entries = await readZip(buf);
  // Notion filenames carry a trailing 32-hex id: "Title 0123abcd....md"
  const strip = (s) => s.replace(/\s+[0-9a-f]{32}(?=(\.|$))/i, '').replace(/\s+[0-9a-f]{32}$/i, '');
  const stripSeg = (s) => strip(s).trim() || 'Untitled';

  // Prefer "_all.csv" over the view ".csv" when both exist for the same base.
  const csvs = new Map(); // basePath (no _all, no ext) -> entry
  const mds = [];
  for (const e of entries) {
    if (e.dir) continue;
    const name = e.name.replace(/\\/g, '/');
    if (/\.md$/i.test(name)) mds.push({ ...e, name });
    else if (/\.csv$/i.test(name)) {
      const base = name.replace(/_all\.csv$/i, '').replace(/\.csv$/i, '');
      const prev = csvs.get(base);
      const isAll = /_all\.csv$/i.test(name);
      if (!prev || isAll) csvs.set(base, { ...e, name, isAll });
    }
  }

  // Plan everything in memory first, then write in large batches —
  // a Worker may only make ~1000 DB calls per request, and big exports
  // have far more pages than that. One batch() call covers many inserts.
  const folderIds = new Map(); // joined RAW segments -> id
  const t = now();
  let created = { pages: 0, databases: 0, rows: 0 };
  const pageRows = [];  // [id,parent,title,kind,content,fields_json,sort]
  const dbRows = [];    // [id,page_id,data_json,sort]

  // Split a zip path into segments, dropping Notion's top-level "Export…" wrapper
  // folder so imported content lands at the root of the sidebar.
  function normParts(name) {
    let parts = name.split('/').filter(Boolean);
    if (parts.length > 1 && /^Export[ _-]/i.test(parts[0])) parts = parts.slice(1);
    return parts;
  }

  function ensureFolder(segments) {
    let parent = null, key = '';
    for (const raw of segments) {
      key = key ? key + '/' + raw : raw;
      if (folderIds.has(key)) { parent = folderIds.get(key); continue; }
      const id = newId();
      pageRows.push([id, parent, stripSeg(raw), 'page', '', '[]', pageRows.length + 1]);
      created.pages++;
      folderIds.set(key, id);
      parent = id;
    }
    return parent;
  }

  // CSV databases.
  for (const [base, e] of csvs) {
    const parts = normParts(base);
    const name = parts.pop();
    const parent = ensureFolder(parts);
    const text = new TextDecoder().decode(await e.data()).replace(/^\uFEFF/, '');
    const table = parseCSV(text);
    if (!table.length) continue;
    const header = table[0];
    const fields = header.map(h => ({ name: h || 'Field', type: 'text' }));
    const id = newId();
    pageRows.push([id, parent, stripSeg(name), 'database', '', JSON.stringify(fields), pageRows.length + 1]);
    created.databases++;
    folderIds.set(parts.concat([name]).join('/'), id); // children nest under the database
    let sort = 0;
    for (let r = 1; r < table.length; r++) {
      const data = {};
      header.forEach((h, c) => { if (table[r][c]) data[h || 'Field'] = table[r][c]; });
      if (!Object.keys(data).length) continue;
      dbRows.push([newId(), id, JSON.stringify(data), ++sort]);
      created.rows++;
    }
  }

  // Markdown pages. If an .md file shares its base name with a folder,
  // its content becomes that folder-page's content.
  const folderContent = new Map(); // folder page id -> content
  for (const e of mds) {
    const parts = normParts(e.name);
    const file = parts.pop();
    const base = parts.concat([file.replace(/\.md$/i, '')]).join('/');
    let text = new TextDecoder().decode(await e.data());
    // Drop the duplicated "# Title" first line Notion writes.
    const title = stripSeg(file.replace(/\.md$/i, ''));
    text = text.replace(/^# .*\n+/, '');
    const parent = ensureFolder(parts);
    if (folderIds.has(base)) {
      folderContent.set(folderIds.get(base), text);
    } else {
      const id = newId();
      pageRows.push([id, parent, title, 'page', text, '[]', pageRows.length + 1]);
      created.pages++;
      folderIds.set(base, id);
    }
  }
  // Merge folder-page content in before inserting (no UPDATE calls needed).
  for (const r of pageRows) {
    if (folderContent.has(r[0])) r[4] = folderContent.get(r[0]);
  }

  // Flush: chunks of 80 statements per batch() call. Even 10,000 pages
  // is ~125 DB calls, far under the per-request limit.
  const pageIns = env.DB.prepare(
    'INSERT INTO pages (id,parent_id,title,kind,content,fields_json,sort,archived,created,updated) VALUES (?,?,?,?,?,?,?,0,?,?)');
  const rowIns = env.DB.prepare(
    'INSERT INTO db_rows (id,page_id,data_json,sort,created,updated) VALUES (?,?,?,?,?,?)');
  const stmts = [];
  for (const r of pageRows) stmts.push(pageIns.bind(r[0], r[1], r[2], r[3], r[4], r[5], r[6], t, t));
  for (const r of dbRows) stmts.push(rowIns.bind(r[0], r[1], r[2], r[3], t, t));
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));

  return { ok: true, created };
}

function parseCSV(text) {
  const rows = []; let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

// Minimal ZIP reader: central directory + deflate-raw entries.
async function readZip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  // find End Of Central Directory (signature 0x06054b50), scanning back
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65536); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file (no end-of-directory found).');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const cmtLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nameLen));
    entries.push({
      name,
      dir: name.endsWith('/'),
      data: async () => {
        // local header: 30 bytes + name + extra (lengths from LOCAL header)
        const ln = dv.getUint16(lho + 26, true);
        const le = dv.getUint16(lho + 28, true);
        const start = lho + 30 + ln + le;
        const raw = u8.subarray(start, start + csize);
        if (method === 0) return raw.slice();
        if (method === 8) {
          const ds = new DecompressionStream('deflate-raw');
          const out = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
          return new Uint8Array(out);
        }
        throw new Error('Unsupported zip compression method ' + method);
      }
    });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}
