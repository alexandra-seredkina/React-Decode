import { traverse, t, chainName, keyName, locOf } from '../ast.js';

const SECRET_PATTERNS = [
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe key', /\b(?:sk|pk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}\b/],
  ['GitHub token', /\bgh[pousr]_[0-9A-Za-z]{36,}\b/],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/],
  ['Sentry DSN', /https:\/\/[0-9a-f]{20,}@[\w.-]+\/\d+/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Mapbox token', /\bpk\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/],
];
const SECRET_NAME = /(secret|passw(or)?d|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)/i;
const UI_KEYS = new Set(['children', 'placeholder', 'title', 'aria-label', 'alt', 'label', 'description', 'helperText', 'text']);
const ROUTE_HINT_KEYS = new Set(['element', 'Component', 'component', 'children', 'lazy', 'index', 'loader', 'action', 'render']);
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp[34]|webm|css|map|wasm)(\?|$)/i;

const LIB_SIGNATURES = [
  ['react', /__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED|react\.element|Symbol\.for\("react\.transitional\.element"\)/],
  ['react-dom', /reconcilerVersion|rendererVersion|createRoot|hydrateRoot/],
  ['react-router', /@remix-run\/router|RouterProvider|createBrowserRouter|react-router/],
  ['redux', /redux\.js\.org\/Errors|@@observable/],
  ['@reduxjs/toolkit', /createSlice|createAsyncThunk/],
  ['zustand', /zustand/],
  ['mobx', /mobx/],
  ['@tanstack/react-query', /QueryClientProvider|queryKey/],
  ['swr', /useSWR|swr/],
  ['axios', /isAxiosError|axios/],
  ['socket.io-client', /socket\.io/],
  ['framer-motion', /framer-motion|AnimatePresence/],
  ['i18next', /i18next/],
  ['@sentry', /@sentry|Sentry\./],
  ['lodash', /__lodash_hash_undefined__/],
  ['moment', /moment\.js|moment\(/],
  ['dayjs', /dayjs/],
  ['zod', /ZodError|ZodType/],
  ['react-hook-form', /react-hook-form|useForm/],
  ['formik', /formik/],
  ['styled-components', /styled-components|sc-component-id/],
  ['@emotion', /@emotion|emotion-cache/],
  ['@mui', /Mui[A-Z]\w+-root|@mui/],
  ['antd', /ant-[a-z]+-/],
  ['next.js', /__NEXT_DATA__|_next\/static/],
  ['vite', /__vite__mapDeps|vite\/preload|__vitePreload/],
  ['webpack', /__webpack_require__|webpackChunk/],
  ['esbuild', /__commonJS|__toESM/],
  ['graphql', /graphql|gql`/],
  ['apollo-client', /ApolloClient|apollo/],
];

function joinRoute(segs) {
  const parts = segs.map((x) => x.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return `/${parts.join('/')}`;
}

export function analyzeStatic(ast, code) {
  const r = {
    urls: new Map(),
    paths: new Map(),
    assets: new Set(),
    emails: new Set(),
    routes: [],
    links: new Set(),
    env: new Map(),
    storage: new Map(),
    secrets: [],
    graphql: [],
    uiText: new Set(),
    libraries: new Map(),
    globals: new Set(),
    appStatements: new Set(),
  };
  const addTo = (map, key, loc) => {
    if (!map.has(key)) map.set(key, loc);
  };

  const topStatement = (p) => p.findParent((x) => x.parentPath?.isProgram())?.node ?? null;

  function handleString(value, loc, p) {
    if (!value || value.length > 4000) return;
    const s = value.trim();
    if (!s) return;
    for (const [name, re] of SECRET_PATTERNS) {
      const m = re.exec(s);
      if (m) r.secrets.push({ kind: name, value: m[0], loc, certainty: 'pattern' });
    }
    if (/^(https?|wss?):\/\/[^\s]+$/i.test(s)) addTo(r.urls, s, loc);
    else if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(s)) r.emails.add(s);
    else if (/^\/[A-Za-z0-9_\-./{}:$%?=&@~+]*$/.test(s) && s.length > 1 && /[A-Za-z]/.test(s)) {
      if (ASSET_EXT.test(s)) r.assets.add(s);
      else addTo(r.paths, s, loc);
    }
    if (/^\s*(query|mutation|subscription|fragment)\b[^{]*\{[\s\S]*\}\s*$/.test(value)) {
      const name = /^\s*(?:query|mutation|subscription|fragment)\s+(\w+)/.exec(value)?.[1] ?? null;
      r.graphql.push({ name, kind: /^\s*(\w+)/.exec(value)[1], text: value.trim().slice(0, 4000), loc });
    }
    if (p) {
      const st = topStatement(p);
      if (st && (/^\/api\b/.test(s) || /^https?:\/\//.test(s))) r.appStatements.add(st);
    }
  }

  function uiText(value) {
    const s = value.replace(/\s+/g, ' ').trim();
    if (s.length < 2 || s.length > 300) return;
    if (!/\p{L}/u.test(s)) return;
    if (/^[\w.:/#-]+$/.test(s) && !/\p{Lu}/u.test(s[0])) return; // identifier-ish tokens
    if (/^(https?:|\/|#|\.)/.test(s)) return;
    r.uiText.add(s);
  }

  function routeFull(objPath) {
    // climb through `children` arrays/props to build the full path
    const segs = [];
    let cur = objPath;
    for (let guard = 0; guard < 12 && cur; guard++) {
      let up = cur.parentPath;
      let parentObj = null;
      while (up && !up.isFunction()) {
        if (up.isObjectProperty() && keyName(up.node) === 'children' && up.parentPath?.isObjectExpression()) {
          parentObj = up.parentPath;
          break;
        }
        if (up.isProgram()) break;
        up = up.parentPath;
      }
      if (!parentObj) break;
      const pp = parentObj.get('properties').find((x) => x.isObjectProperty() && keyName(x.node) === 'path');
      if (pp?.get('value').isStringLiteral()) segs.unshift(pp.node.value.value);
      cur = parentObj;
    }
    return segs;
  }

  traverse(ast, {
    StringLiteral(p) {
      const parent = p.parentPath;
      handleString(p.node.value, locOf(p.node), p);
      // ui text through well-known props
      if (parent.isObjectProperty() && parent.node.value === p.node && UI_KEYS.has(keyName(parent.node))) uiText(p.node.value);
      if (parent.isArrayExpression() && parent.parentPath.isObjectProperty() && keyName(parent.parentPath.node) === 'children') uiText(p.node.value);
      if (parent.isObjectProperty() && parent.node.value === p.node) {
        const k = keyName(parent.node);
        if ((k === 'to' || k === 'href') && p.node.value.startsWith('/')) r.links.add(p.node.value);
        if (k && SECRET_NAME.test(k)) {
          const v = p.node.value;
          if (v.length >= 8 && !/\s/.test(v) && !v.startsWith('/') && !/^https?:/.test(v) && v !== k && !/^[a-z]+(-[a-z]+)+$/.test(v)) {
            r.secrets.push({ kind: `value of "${k}"`, value: v, loc: locOf(p.node), certainty: 'heuristic' });
          }
        }
      }
    },
    TemplateLiteral(p) {
      const text = p.node.quasis.map((q) => q.value.cooked ?? '').join('{}');
      if (p.node.expressions.length === 0) handleString(text, locOf(p.node), p);
      else if (/^\s*(query|mutation|subscription)\b/.test(text)) handleString(p.node.quasis.map((q) => q.value.cooked).join('${…}'), locOf(p.node), p);
      else if (/^\/[\w\-./{}]+/.test(text) && /[A-Za-z]/.test(text) && !ASSET_EXT.test(text)) addTo(r.paths, text, locOf(p.node));
    },
    JSXText(p) {
      uiText(p.node.value);
    },
    MemberExpression(p) {
      const chain = chainName(p.node);
      if (!chain) return;
      const m = /^(?:import\.meta\.env|process\.env)\.([A-Za-z_][\w]*)$/.exec(chain);
      if (m && !(p.parentPath.isMemberExpression() && p.parentPath.node.object === p.node)) {
        addTo(r.env, m[1], locOf(p.node));
      }
      if (/^(window|globalThis|self)\.__[A-Za-z0-9_]+__?$/.test(chain)) r.globals.add(chain);
    },
    CallExpression(p) {
      const c = p.node.callee;
      // jsx runtime / createElement calls mark app code
      if (t.isMemberExpression(c) && !c.computed && ['jsx', 'jsxs', 'jsxDEV', 'createElement'].includes(c.property.name) && t.isIdentifier(c.object)) {
        const st = topStatement(p);
        if (st) r.appStatements.add(st);
      }
      const cn = chainName(c);
      if (!cn) return;
      const m = /(?:^|\.)(local|session)Storage\.(getItem|setItem|removeItem)$/.exec(cn);
      if (m) {
        const a0 = p.node.arguments[0];
        if (t.isStringLiteral(a0)) {
          const key = a0.value;
          const rec = r.storage.get(key) ?? { store: `${m[1]}Storage`, ops: new Set(), loc: locOf(p.node) };
          rec.ops.add(m[2]);
          r.storage.set(key, rec);
        }
      }
    },
    ObjectExpression(p) {
      const props = p.node.properties.filter((x) => t.isObjectProperty(x) || t.isObjectMethod(x));
      const keys = props.map((x) => keyName(x));
      const pathProp = props.find((x) => t.isObjectProperty(x) && keyName(x) === 'path');
      if (pathProp && t.isStringLiteral(pathProp.value) && keys.some((k) => ROUTE_HINT_KEYS.has(k))) {
        const segs = routeFull(p);
        const own = pathProp.value.value;
        const lazy = keys.includes('lazy');
        r.routes.push({ path: joinRoute([...segs, own]), own, lazy, loc: locOf(p.node) });
        const st = topStatement(p);
        if (st) r.appStatements.add(st);
      } else if (keys.includes('index') && keys.includes('element')) {
        r.routes.push({ path: joinRoute(routeFull(p)), own: '', index: true, lazy: false, loc: locOf(p.node) });
      }
    },
  });

  // libraries from comments (esbuild/rollup path banners, license headers)
  for (const c of ast.comments ?? []) {
    const nm = /node_modules\/((?:@[^/\s]+\/)?[^/\s]+)/.exec(c.value);
    if (nm) r.libraries.set(nm[1], { evidence: 'path comment' });
    const lic = /@license\s+([^\n*]+)/.exec(c.value);
    if (lic) {
      const name = /^\s*([A-Za-z0-9@/._-]+)\s+v?(\d+\.\d+\.\d+[\w.-]*)/.exec(lic[1]);
      if (name) r.libraries.set(name[1], { version: name[2], evidence: 'license banner' });
    }
  }
  for (const [name, re] of LIB_SIGNATURES) {
    if (!r.libraries.has(name) && re.test(code)) r.libraries.set(name, { evidence: 'code signature' });
  }
  const rv = /(?:reconcilerVersion|rendererVersion|reactVersion)\s*:\s*"(\d+\.\d+\.\d+[\w.-]*)"/.exec(code) ?? /\bversion\s*=\s*"(\d+\.\d+\.\d+)"[^]{0,300}?react/.exec(code);
  if (rv && r.libraries.has('react')) r.libraries.get('react').version = rv[1];
  return r;
}
