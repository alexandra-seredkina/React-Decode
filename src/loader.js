import fs from 'node:fs/promises';
import path from 'node:path';
import { findMapReference } from './sourcemap.js';

const isUrl = (s) => /^https?:\/\//i.test(s);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function uniqueName(used, base) {
  let name = base || 'bundle.js';
  let i = 1;
  while (used.has(name)) {
    const ext = path.extname(base);
    name = `${base.slice(0, base.length - ext.length)}.${++i}${ext}`;
  }
  used.add(name);
  return name;
}

/** Candidate chunk references inside a JS file. */
export function findChunkRefs(code) {
  const refs = new Set();
  const add = (s) => {
    if (/\.m?js(\?[^"']*)?$/.test(s) && !/^https?:\/\/(?!)/.test('') && s.length < 200) refs.add(s);
  };
  for (const m of code.matchAll(/["'`]((?:\.{1,2}\/|\/)?[\w@./-]*?[\w.-]+\.m?js)["'`]/g)) add(m[1]);
  for (const m of code.matchAll(/__vite__mapDeps\(\[([^\]]*)\]/g)) {
    // handled by the generic string scan above; kept for clarity
    for (const s of m[1].matchAll(/"([^"]+\.m?js)"/g)) add(s[1]);
  }
  // webpack 5 chunk url function:  e => "static/js/" + e + "." + {1:"abc"}[e] + ".chunk.js"
  const w = /"([^"]*)"\s*\+\s*\w+\s*\+\s*"([^"]*)"\s*\+\s*\{([^}]*)\}\[\w+\]\s*\+\s*"(\.chunk\.js|\.js)"/.exec(code);
  if (w) {
    for (const kv of w[3].matchAll(/["']?([\w-]+)["']?\s*:\s*"([\w-]+)"/g)) refs.add(`${w[1]}${kv[1]}${w[2]}${kv[2]}${w[4]}`);
  }
  return [...refs];
}

async function httpGet(url, headers, asText = true) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*', ...headers }, redirect: 'follow' });
  if (!res.ok) return { ok: false, status: res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') ?? '';
  return { ok: true, status: res.status, type, text: asText ? buf.toString('utf8') : null, url: res.url };
}

const looksLikeHtml = (s) => /^\s*<(!doctype|html|head|body|\?xml)/i.test(s);

function htmlScripts(html, baseUrl) {
  const urls = [];
  const inline = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[1]);
    if (src) urls.push(src[1]);
    else if (m[2].trim() && !/type\s*=\s*["'](application\/(ld\+)?json|importmap|text\/template)/i.test(m[1])) inline.push(m[2]);
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (/rel\s*=\s*["']?(modulepreload|preload)/i.test(tag) && /(as\s*=\s*["']?script|modulepreload)/i.test(tag)) {
      const h = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
      if (h) urls.push(h[1]);
    }
  }
  return { urls: urls.map((u) => (baseUrl ? new URL(u, baseUrl).toString() : u)), inline };
}

export async function loadInput(input, opts = {}) {
  const { followChunks = true, maxFiles = 150, headers = {}, log = () => {} } = opts;
  const result = { origin: null, entries: [], maps: [], notes: [] };
  const usedNames = new Set();
  const queue = [];
  const seen = new Set();

  const push = (entry) => {
    entry.name = uniqueName(usedNames, entry.name);
    result.entries.push(entry);
  };

  if (isUrl(input)) {
    const first = await httpGet(input, headers);
    if (!first.ok) throw new Error(`GET ${input} -> HTTP ${first.status}`);
    const base = first.url;
    result.origin = new URL(base).origin;
    if (looksLikeHtml(first.text)) {
      push({ name: 'index.html', code: first.text, kind: 'html', url: base });
      const { urls, inline } = htmlScripts(first.text, base);
      inline.forEach((code, i) => push({ name: `inline-${i + 1}.js`, code, kind: 'js', url: base }));
      for (const u of urls) queue.push(u);
      // build manifests list every emitted chunk
      for (const m of ['/asset-manifest.json', '/.vite/manifest.json', '/manifest.json']) {
        try {
          const r = await httpGet(new URL(m, base).toString(), headers);
          if (!r.ok || looksLikeHtml(r.text)) continue;
          const j = JSON.parse(r.text);
          const files = new Set();
          const walk = (v) => {
            if (typeof v === 'string' && /\.m?js$/.test(v)) files.add(v);
            else if (v && typeof v === 'object') Object.values(v).forEach(walk);
          };
          walk(j);
          for (const f of files) queue.push(new URL(f.replace(/^\.?\//, '/'), base).toString());
          if (files.size) result.notes.push(`manifest ${m}: ${files.size} script(s)`);
        } catch {
          /* no manifest */
        }
      }
    } else {
      queue.push(base);
    }
  } else {
    const abs = path.resolve(input);
    const st = await fs.stat(abs);
    if (st.isDirectory()) {
      const files = await walk(abs);
      for (const f of files) {
        if (/\.(m?js|cjs)$/.test(f) && !/\.min\.map$/.test(f)) {
          push({ name: path.relative(abs, f).split(path.sep).join('__'), code: await fs.readFile(f, 'utf8'), kind: 'js', file: f });
        } else if (/\.map$/.test(f)) {
          try {
            result.maps.push({ forName: path.relative(abs, f).replace(/\.map$/, '').split(path.sep).join('__'), map: JSON.parse(await fs.readFile(f, 'utf8')) });
          } catch {
            /* bad map */
          }
        } else if (/\.html?$/.test(f) && result.entries.length === 0) {
          // keep for reference only
        }
      }
    } else if (/\.html?$/.test(abs)) {
      const html = await fs.readFile(abs, 'utf8');
      push({ name: path.basename(abs), code: html, kind: 'html', file: abs });
      const { urls, inline } = htmlScripts(html, null);
      inline.forEach((code, i) => push({ name: `inline-${i + 1}.js`, code, kind: 'js' }));
      for (const u of urls) {
        if (isUrl(u)) {
          queue.push(u);
          continue;
        }
        const f = path.resolve(path.dirname(abs), u.replace(/^\//, '').split('?')[0]);
        try {
          push({ name: path.basename(f), code: await fs.readFile(f, 'utf8'), kind: 'js', file: f });
        } catch {
          result.notes.push(`missing script referenced by html: ${u}`);
        }
      }
    } else if (/\.map$/.test(abs)) {
      result.maps.push({ forName: path.basename(abs).replace(/\.map$/, ''), map: JSON.parse(await fs.readFile(abs, 'utf8')) });
    } else {
      push({ name: path.basename(abs), code: await fs.readFile(abs, 'utf8'), kind: 'js', file: abs });
    }
  }

  // ---- remote fetch loop (scripts, chunks, maps) -------------------------
  let fetched = 0;
  while (queue.length && fetched < maxFiles) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    let r;
    try {
      r = await httpGet(url, headers);
    } catch (e) {
      result.notes.push(`fetch failed ${url}: ${e.message}`);
      continue;
    }
    if (!r.ok || looksLikeHtml(r.text)) continue; // SPA fallback => not a real file
    fetched++;
    log(`  fetched ${url} (${r.text.length} bytes)`);
    const name = path.basename(new URL(url).pathname) || 'bundle.js';
    push({ name, code: r.text, kind: 'js', url });
    if (!result.origin) result.origin = new URL(url).origin;

    // source map: comment first, otherwise <url>.map
    const ref = findMapReference(r.text);
    try {
      if (ref?.inline) result.maps.push({ forName: name, map: ref.inline });
      else {
        const mapUrl = ref?.url ? new URL(ref.url, url).toString() : `${url}.map`;
        const m = await httpGet(mapUrl, headers);
        if (m.ok && !looksLikeHtml(m.text)) result.maps.push({ forName: name, map: JSON.parse(m.text) });
      }
    } catch {
      /* no map */
    }

    if (followChunks) {
      for (const ref2 of findChunkRefs(r.text)) {
        const cands = [];
        try {
          if (/^(\.|\.\.)\//.test(ref2)) cands.push(new URL(ref2, url).toString());
          else {
            cands.push(new URL(ref2, url).toString());
            if (result.origin) cands.push(new URL(ref2.replace(/^\//, ''), `${result.origin}/`).toString());
          }
        } catch {
          continue;
        }
        for (const c of cands) if (!seen.has(c)) queue.push(c);
      }
    }
  }
  if (queue.length && fetched >= maxFiles) result.notes.push(`stopped after ${maxFiles} files (use --max-files)`);
  return result;
}

async function walk(dir, out = []) {
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.git')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}
