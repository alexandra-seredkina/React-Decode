import { mergeConcrete } from './analyze/requests.js';

const mask = (s) => (s.length <= 12 ? `${s.slice(0, 3)}…` : `${s.slice(0, 6)}…${s.slice(-4)}`);

/** Merge per-file results into one view. Source-map sources go first (they are richer). */
function aggregate(all) {
  const endpoints = new Map();
  const dynamic = [];
  const realtime = new Map();
  const S = {
    urls: new Map(), paths: new Map(), assets: new Set(), emails: new Set(), routes: new Map(), links: new Set(),
    env: new Map(), storage: new Map(), secrets: new Map(), graphql: new Map(), uiText: new Set(), libraries: new Map(),
    globals: new Set(),
  };
  for (const r of all) {
    if (r.requests) {
      for (const e of r.requests.endpoints) {
        const key = `${e.method} ${e.path.replace(/\{[^}]*\}/g, '{}')}`;
        const prev = endpoints.get(key);
        if (!prev) endpoints.set(key, { ...e, file: r.name });
        else {
          prev.callSites += e.callSites;
          for (const f of e.body) if (!prev.body.some((x) => x.name === f.name)) prev.body.push(f);
          for (const f of e.query) if (!prev.query.some((x) => x.name === f.name)) prev.query.push(f);
          prev.response = [...new Set([...prev.response, ...e.response])].sort();
        }
      }
      for (const d of r.requests.dynamic) dynamic.push({ ...d, file: r.name });
      for (const w of r.requests.realtime) realtime.set(`${w.type} ${w.url}`, { ...w, file: r.name });
    }
    const s = r.statics;
    if (!s) continue;
    for (const [k, v] of s.urls) if (!S.urls.has(k)) S.urls.set(k, { ...v, file: r.name });
    for (const [k, v] of s.paths) if (!S.paths.has(k)) S.paths.set(k, { ...v, file: r.name });
    s.assets.forEach((x) => S.assets.add(x));
    s.emails.forEach((x) => S.emails.add(x));
    s.links.forEach((x) => S.links.add(x));
    s.uiText.forEach((x) => S.uiText.add(x));
    s.globals.forEach((x) => S.globals.add(x));
    for (const rt of s.routes) {
      const k = rt.index ? `${rt.path} (index)` : rt.path;
      if (!S.routes.has(k)) S.routes.set(k, { ...rt, file: r.name });
    }
    for (const [k, v] of s.env) if (!S.env.has(k)) S.env.set(k, { ...v, file: r.name });
    for (const [k, v] of s.storage) {
      const prev = S.storage.get(k);
      if (prev) v.ops.forEach((o) => prev.ops.add(o));
      else S.storage.set(k, { ...v, ops: new Set(v.ops), file: r.name });
    }
    for (const x of s.secrets) if (!S.secrets.has(x.value)) S.secrets.set(x.value, { ...x, file: r.name });
    for (const g of s.graphql) if (!S.graphql.has(g.text)) S.graphql.set(g.text, { ...g, file: r.name });
    for (const [k, v] of s.libraries) {
      const prev = S.libraries.get(k);
      if (!prev || (!prev.version && v.version)) S.libraries.set(k, v);
    }
  }
  return { endpoints: mergeConcrete([...endpoints.values()]), dynamic, realtime: [...realtime.values()], S };
}

function schemaFromFields(fields) {
  const root = { type: 'object', properties: {} };
  for (const f of fields) {
    const segs = f.name.split('.');
    let node = root;
    segs.forEach((seg, i) => {
      const isArr = seg.endsWith('[]');
      const name = isArr ? seg.slice(0, -2) : seg;
      if (!name) return;
      node.properties ??= {};
      const last = i === segs.length - 1;
      let child = node.properties[name];
      if (!child) {
        child = last ? scalar(f.type) : { type: 'object', properties: {} };
        if (isArr) child = { type: 'array', items: last ? scalar(f.type) : { type: 'object', properties: {} } };
        node.properties[name] = child;
      }
      node = isArr ? (child.items ??= { type: 'object', properties: {} }) : child;
    });
  }
  return root;
}

function scalar(type) {
  const base = String(type ?? 'any').split('|')[0];
  const nullable = String(type ?? '').includes('null');
  const map = { string: 'string', number: 'number', boolean: 'boolean', object: 'object', array: 'array', 'string|file': 'string' };
  const s = map[base] ? { type: map[base] } : {};
  if (base === 'array') s.items = {};
  if (nullable) s.nullable = true;
  if (type === 'string|file') s.format = 'binary';
  return s;
}

function buildOpenApi(endpoints, origin, title) {
  const paths = {};
  const servers = new Set();
  for (const e of endpoints) {
    let p = e.path;
    const abs = /^https?:\/\/[^/]+/.exec(p);
    if (abs) {
      servers.add(abs[0]);
      p = p.slice(abs[0].length) || '/';
    }
    if (!p.startsWith('/')) p = `/${p}`;
    const pathParams = [];
    p = p.replace(/\{([^}]*)\}/g, (_, n) => {
      let name = n.replace(/[^\w]/g, '_') || 'param';
      while (pathParams.includes(name)) name += '_';
      pathParams.push(name);
      return `{${name}}`;
    });
    const op = {
      summary: e.context ? `${e.context}` : undefined,
      parameters: [
        ...pathParams.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
        ...e.query.map((q) => ({ name: q.name, in: 'query', required: false, schema: scalar(q.type) })),
      ],
      responses: {
        200: {
          description: e.streaming ? 'Streamed response (SSE / chunked)' : 'Success',
          content: e.streaming
            ? { 'text/event-stream': { schema: { type: 'string' } } }
            : { 'application/json': { schema: schemaFromFields(e.response.map((name) => ({ name, type: 'any' }))) } },
        },
      },
    };
    if (e.body.length) {
      op.requestBody = { content: { [e.contentType ?? 'application/json']: { schema: schemaFromFields(e.body) } } };
    }
    paths[p] ??= {};
    paths[p][e.method.toLowerCase()] = op;
  }
  const doc = {
    openapi: '3.0.3',
    info: { title: title ?? 'Recovered API', version: '0.0.0', description: 'Reconstructed by static analysis of a client bundle. Types are best-effort.' },
    paths,
  };
  const list = [...servers];
  if (origin && !list.length) list.push(origin);
  if (list.length) doc.servers = list.map((url) => ({ url }));
  return doc;
}

const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const fmtFields = (fs) => (fs.length ? fs.map((f) => `\`${f.name}${f.example !== undefined ? `=${f.example}` : ''}\`${f.example === undefined && f.type && f.type !== 'any' ? `:${f.type}` : ''}${f.optional ? '?' : ''}`).join(', ') : '—');

export function buildReport({ input, loaded, results, sourceResults, opts }) {
  const all = [...sourceResults, ...results];
  const { endpoints, dynamic, realtime, S } = aggregate(all);
  endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  const origin = opts.origin ?? loaded.origin;

  const json = {
    input: /^https?:/.test(input) ? input : undefined,
    origin,
    files: results.map((r) => ({ name: r.name, bytes: r.bytes, error: r.error ?? undefined, renamed: r.renames.length })),
    sourceMapSources: sourceResults.length,
    libraries: Object.fromEntries(S.libraries),
    endpoints,
    dynamicRequests: dynamic,
    realtime,
    routes: [...S.routes.values()],
    links: [...S.links],
    graphql: [...S.graphql.values()],
    env: [...S.env.keys()],
    globals: [...S.globals],
    storage: [...S.storage].map(([key, v]) => ({ key, store: v.store, ops: [...v.ops] })),
    urls: [...S.urls.keys()],
    paths: [...S.paths.keys()],
    assets: [...S.assets],
    emails: [...S.emails],
    secrets: [...S.secrets.values()].map(({ kind, value, certainty, file }) => ({ kind, value, certainty, file })),
    uiText: [...S.uiText],
    notes: loaded.notes,
  };

  const L = [];
  L.push('# Bundle analysis', '');
  L.push(`- Files analysed: **${results.length}**` + (sourceResults.length ? ` (+ ${sourceResults.length} original sources from source maps)` : ''));
  if (origin) L.push(`- Origin: ${origin}`);
  for (const n of loaded.notes) L.push(`- Note: ${n}`);
  for (const r of results) if (r.error) L.push(`- ⚠ ${r.name}: ${r.error.split('\n')[0]}`);
  L.push('');

  if (S.libraries.size) {
    L.push('## Libraries', '');
    L.push([...S.libraries].map(([k, v]) => `\`${k}${v.version ? `@${v.version}` : ''}\``).join(', '), '');
  }

  L.push(`## HTTP endpoints (${endpoints.length})`, '');
  if (endpoints.length) {
    L.push('| Method | Path | Query | Body | Response fields used | Via | Where |', '|---|---|---|---|---|---|---|');
    for (const e of endpoints) {
      L.push(
        `| ${e.method} | \`${esc(e.path)}\`${e.streaming ? ' 〰 stream' : ''} | ${esc(fmtFields(e.query))} | ${esc(fmtFields(e.body))}${e.bodyNote ? ` _(${esc(e.bodyNote)})_` : ''} | ${e.response.length ? esc(e.response.map((x) => `\`${x}\``).join(', ')) : '—'} | ${e.via} | ${esc(e.context ?? '')} |`,
      );
    }
    L.push('');
    const withHeaders = endpoints.filter((e) => e.headers.length);
    if (withHeaders.length) {
      L.push('### Request headers set by the client', '');
      const seen = new Set();
      for (const e of withHeaders) for (const h of e.headers) seen.add(`${h.name}${h.value ? `: ${h.value}` : ''}`);
      for (const h of seen) L.push(`- \`${h}\``);
      L.push('');
    }
    const creds = new Set(endpoints.map((e) => e.credentials).filter(Boolean));
    if (creds.size) L.push(`Fetch \`credentials\`: ${[...creds].map((c) => `\`${c}\``).join(', ')}`, '');
  } else L.push('_none found_', '');

  if (dynamic.length) {
    L.push(`### Requests with fully dynamic URL (${dynamic.length})`, '');
    for (const d of dynamic) L.push(`- \`${d.url}\` — ${d.kind}${d.context ? ` in \`${d.context}\`` : ''} (${d.file}${d.loc ? `:${d.loc.line}:${d.loc.column}` : ''})`);
    L.push('');
  }
  if (realtime.length) {
    L.push('## Realtime connections', '');
    for (const w of realtime) L.push(`- ${w.type}: \`${w.url}\``);
    L.push('');
  }
  if (S.routes.size) {
    L.push('## Client routes', '');
    for (const r of S.routes.values()) L.push(`- \`${r.path}\`${r.index ? ' (index)' : ''}${r.lazy ? ' (lazy)' : ''}`);
    L.push('');
  }
  if (S.graphql.size) {
    L.push('## GraphQL documents', '');
    for (const g of S.graphql.values()) L.push(`### ${g.kind} ${g.name ?? ''}`, '```graphql', g.text, '```');
    L.push('');
  }
  if (S.env.size || S.globals.size) {
    L.push('## Environment / globals', '');
    for (const k of S.env.keys()) L.push(`- env \`${k}\``);
    for (const g of S.globals) L.push(`- global \`${g}\``);
    L.push('');
  }
  if (S.storage.size) {
    L.push('## Browser storage keys', '');
    for (const [k, v] of S.storage) L.push(`- \`${k}\` — ${v.store} (${[...v.ops].join(', ')})`);
    L.push('');
  }
  if (S.secrets.size) {
    L.push('## Potential secrets', '');
    for (const s of S.secrets.values()) L.push(`- **${s.kind}** (${s.certainty}) \`${mask(s.value)}\` — ${s.file}`);
    L.push('', '_Values are masked. Run with `--json` to get them in full._', '');
  }
  if (S.urls.size) {
    const hosts = new Map();
    for (const u of S.urls.keys()) {
      try {
        const h = new URL(u).host;
        hosts.set(h, (hosts.get(h) ?? 0) + 1);
      } catch {
        /* ignore */
      }
    }
    L.push('## External URLs', '');
    for (const [h, n] of [...hosts].sort((a, b) => b[1] - a[1])) L.push(`- ${h} (${n})`);
    L.push('');
  }
  if (S.paths.size) {
    L.push('## Other path-like strings', '');
    for (const p of [...S.paths.keys()].slice(0, 200)) L.push(`- \`${p}\``);
    L.push('');
  }
  if (S.uiText.size) {
    L.push('## UI text (first 80)', '');
    for (const s of [...S.uiText].slice(0, 80)) L.push(`- ${s}`);
    L.push('');
  }
  return { json, markdown: L.join('\n'), openapi: buildOpenApi(endpoints, origin) };
}
