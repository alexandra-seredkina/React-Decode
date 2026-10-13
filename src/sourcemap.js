import path from 'node:path';

/** Pull the sourceMappingURL out of a bundle. Returns {url} | {inline: object} | null */
export function findMapReference(code) {
  const m = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/m.exec(code.slice(-2048)) ?? /\/\*[#@]\s*sourceMappingURL=([^\s*]+)\s*\*\//.exec(code.slice(-2048));
  if (!m) return null;
  const ref = m[1];
  if (ref.startsWith('data:')) {
    const comma = ref.indexOf(',');
    const meta = ref.slice(0, comma);
    const payload = ref.slice(comma + 1);
    try {
      const text = /;base64/.test(meta) ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload);
      return { inline: JSON.parse(text) };
    } catch {
      return null;
    }
  }
  return { url: ref };
}

export function safeSourcePath(source) {
  let s = source.replace(/^[a-z][a-z0-9+.-]*:\/\/\/?/i, '').replace(/^\.\//, '');
  s = s.replace(/\?.*$/, '');
  s = path.posix.normalize(s).replace(/^(\.\.\/)+/, '').replace(/^\/+/, '');
  s = s.replace(/[<>:"|?*\0]/g, '_');
  const parts = s.split('/').filter((x) => x && x !== '..');
  return parts.join('/') || 'unknown';
}

/** Return [{path, content, isLibrary}] from a parsed source map object. */
export function extractSources(map) {
  const out = [];
  if (!map || !Array.isArray(map.sources)) return out;
  map.sources.forEach((src, i) => {
    const content = map.sourcesContent?.[i];
    if (typeof content !== 'string') return;
    out.push({
      path: safeSourcePath(src),
      original: src,
      content,
      isLibrary: /(^|\/)node_modules\//.test(src) || /^(webpack|vite)\/(runtime|bootstrap)/.test(src),
    });
  });
  return out;
}
