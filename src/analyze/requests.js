import { traverse, t, chainName, keyName, locOf, isIdentName } from '../ast.js';

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const FETCH_NAMES = new Set(['fetch', 'window.fetch', 'globalThis.fetch', 'self.fetch']);
const ARRAY_METHODS = new Set([
  'map', 'filter', 'forEach', 'find', 'findLast', 'some', 'every', 'flatMap', 'reduce', 'sort', 'findIndex',
]);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const RESPONSE_PROPS = new Set(['ok', 'status', 'statusText', 'body', 'headers', 'url', 'redirected', 'type', 'bodyUsed']);
const SKIP_PROPS = new Set(['then', 'catch', 'finally', 'length', 'constructor', 'prototype', 'toString']);

// Parts: array of  string | {param:{index,key?}} | {unk:string}
const hasParam = (parts) => parts.some((x) => typeof x === 'object' && x.param);
const simplify = (parts) => {
  const out = [];
  for (const p of parts) {
    if (p === '' || p == null) continue;
    if (typeof p === 'string' && typeof out[out.length - 1] === 'string') out[out.length - 1] += p;
    else out.push(p);
  }
  return out;
};

export function analyzeRequests(ast) {
  let program;
  traverse(ast, {
    Program(p) {
      program = p;
      p.stop();
    },
  });
  if (!program) return empty();

  const calls = [];
  program.traverse({
    CallExpression(p) {
      calls.push(p);
    },
    NewExpression(p) {
      calls.push(p);
    },
  });

  /** Binding -> spec ; Binding(object) -> Map<key, spec> */
  const byBinding = new Map();
  const byProp = new Map();

  // ---------- helpers -----------------------------------------------------
  const fnOf = (p) => p.getFunctionParent();

  function fnInfo(fnPath) {
    if (!fnPath) return null;
    let p = fnPath;
    // useCallback(fn, deps) / memo(fn)
    if (p.parentPath?.isCallExpression() && p.parentPath.node.arguments[0] === p.node) {
      const last = chainName(p.parentPath.node.callee)?.split('.').pop();
      if (last && /^(useCallback|useMemo|memo|forwardRef)$/.test(last)) p = p.parentPath;
    }
    const parent = p.parentPath;
    if (fnPath.isFunctionDeclaration() && fnPath.node.id) {
      const b = fnPath.parentPath.scope.getBinding(fnPath.node.id.name);
      return b ? { binding: b, name: fnPath.node.id.name } : null;
    }
    if (parent?.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
      const b = parent.scope.getBinding(parent.node.id.name);
      return b ? { binding: b, name: parent.node.id.name } : null;
    }
    if (fnPath.isObjectMethod() || (parent?.isObjectProperty() && parent.node.value === p.node)) {
      const prop = fnPath.isObjectMethod() ? fnPath : parent;
      const key = keyName(prop.node);
      const obj = prop.parentPath;
      const decl = obj?.parentPath;
      if (key != null && obj?.isObjectExpression() && decl?.isVariableDeclarator() && t.isIdentifier(decl.node.id)) {
        const b = decl.scope.getBinding(decl.node.id.name);
        if (b) return { objBinding: b, key, name: `${decl.node.id.name}.${key}` };
      }
    }
    return null;
  }

  function specFor(callee) {
    if (callee.isIdentifier()) {
      const b = callee.scope.getBinding(callee.node.name);
      return b ? byBinding.get(b) : null;
    }
    if ((callee.isMemberExpression() || callee.isOptionalMemberExpression()) && callee.get('object').isIdentifier()) {
      const b = callee.scope.getBinding(callee.node.object.name);
      const k = keyName(callee.node);
      return b && k != null ? byProp.get(b)?.get(k) : null;
    }
    return null;
  }

  function callSitesOf(fnPath) {
    const info = fnInfo(fnPath);
    if (!info) return [];
    const out = [];
    if (info.binding) {
      for (const ref of info.binding.referencePaths) {
        const par = ref.parentPath;
        if (par?.isCallExpression() && par.node.callee === ref.node) out.push(par);
      }
    } else {
      for (const ref of info.objBinding.referencePaths) {
        const m = ref.parentPath;
        if (!m || !(m.isMemberExpression() || m.isOptionalMemberExpression()) || m.node.object !== ref.node) continue;
        if (keyName(m.node) !== info.key) continue;
        const c = m.parentPath;
        if (c?.isCallExpression() && c.node.callee === m.node) out.push(c);
        else if (c?.isOptionalCallExpression?.() && c.node.callee === m.node) out.push(c);
      }
    }
    return out;
  }

  function getObjProp(objPath, name) {
    if (!objPath?.isObjectExpression()) return null;
    for (const prop of objPath.get('properties')) {
      if ((prop.isObjectProperty() || prop.isObjectMethod()) && keyName(prop.node) === name) {
        return prop.isObjectProperty() ? prop.get('value') : prop;
      }
    }
    return null;
  }

  function resolveConst(p, depth = 0) {
    // follow `const x = <expr>` aliases (only when never reassigned)
    if (!p?.node || depth > 5) return p;
    if (p.isIdentifier()) {
      const b = p.scope.getBinding(p.node.name);
      if (b && b.constant && b.path.isVariableDeclarator() && t.isIdentifier(b.path.node.id)) {
        const init = b.path.get('init');
        if (init.node) return resolveConst(init, depth + 1);
      }
    }
    return p;
  }

  function paramOrigin(binding, key) {
    if (!binding || binding.kind !== 'param') return null;
    const fn = binding.scope.path;
    if (!fn?.node?.params) return null;
    const id = binding.identifier;
    for (let i = 0; i < fn.node.params.length; i++) {
      let prm = fn.node.params[i];
      if (t.isAssignmentPattern(prm)) prm = prm.left;
      if (prm === id) return { index: i, name: id.name, ...(key ? { key } : {}) };
      if (t.isObjectPattern(prm)) {
        for (const prop of prm.properties) {
          if (!t.isObjectProperty(prop)) continue;
          let v = prop.value;
          if (t.isAssignmentPattern(v)) v = v.left;
          if (v === id) return { index: i, key: keyName(prop), name: id.name };
        }
      }
    }
    return null;
  }

  // ---------- string / value evaluation ----------------------------------
  function hint(p) {
    const n = p.node;
    if (t.isIdentifier(n)) return n.name;
    if (t.isMemberExpression(n) || t.isOptionalMemberExpression(n)) return keyName(n) ?? 'param';
    if (t.isCallExpression(n)) return chainName(n.callee)?.split('.').pop() ?? 'param';
    return 'param';
  }

  function queryFromParams(binding) {
    // const p = new URLSearchParams({a:..}); p.set("b", ..)
    const init = binding.path.get('init');
    const keys = [];
    if (init.isNewExpression()) {
      const a0 = init.get('arguments.0');
      const obj = a0?.node ? resolveConst(a0) : null;
      if (obj?.isObjectExpression()) {
        for (const prop of obj.node.properties) {
          const k = t.isObjectProperty(prop) ? keyName(prop) : null;
          if (k != null) keys.push(k);
        }
      }
    }
    for (const ref of binding.referencePaths) {
      const m = ref.parentPath;
      if (m?.isMemberExpression() && ['set', 'append'].includes(keyName(m.node))) {
        const c = m.parentPath;
        const first = c?.isCallExpression() ? c.node.arguments[0] : null;
        if (t.isStringLiteral(first)) keys.push(first.value);
      }
    }
    return [...new Set(keys)].map((k) => `${k}={${k}}`).join('&');
  }

  function evalParts(p, ctx, depth = 0) {
    if (!p?.node || depth > 8) return [{ unk: 'param' }];
    const n = p.node;
    switch (n.type) {
      case 'StringLiteral':
        return [n.value];
      case 'NumericLiteral':
        return [String(n.value)];
      case 'BooleanLiteral':
        return [String(n.value)];
      case 'NullLiteral':
        return [''];
      case 'TemplateLiteral': {
        const parts = [];
        n.quasis.forEach((q, i) => {
          parts.push(q.value.cooked ?? q.value.raw);
          if (i < n.expressions.length) parts.push(...evalParts(p.get(`expressions.${i}`), ctx, depth + 1));
        });
        return simplify(parts);
      }
      case 'BinaryExpression':
        if (n.operator === '+') {
          return simplify([...evalParts(p.get('left'), ctx, depth + 1), ...evalParts(p.get('right'), ctx, depth + 1)]);
        }
        return [{ unk: hint(p) }];
      case 'AwaitExpression':
      case 'ParenthesizedExpression':
      case 'TSAsExpression':
      case 'TSNonNullExpression':
        return evalParts(p.get(n.type === 'AwaitExpression' ? 'argument' : 'expression'), ctx, depth + 1);
      case 'ConditionalExpression':
        return evalParts(p.get('consequent'), ctx, depth + 1);
      case 'LogicalExpression': {
        const left = evalParts(p.get('left'), ctx, depth + 1);
        if (left.every((x) => typeof x === 'object' && x.unk)) {
          const right = evalParts(p.get('right'), ctx, depth + 1);
          if (right.some((x) => typeof x === 'string')) return right;
        }
        return left;
      }
      case 'Identifier': {
        if (n.name === 'undefined') return [''];
        const b = p.scope.getBinding(n.name);
        if (!b) return [{ unk: n.name }];
        if (b.kind === 'param') {
          const origin = b.scope.block === ctx.fnNode ? paramOrigin(b) : null;
          return origin ? [{ param: origin }] : [{ unk: n.name }];
        }
        if (b.constant && b.path.isVariableDeclarator() && t.isIdentifier(b.path.node.id)) {
          const init = b.path.get('init');
          if (init.node) {
            if (init.isNewExpression() && chainName(init.node.callee) === 'URLSearchParams') {
              return [queryFromParams(b)];
            }
            return evalParts(init, ctx, depth + 1);
          }
        }
        return [{ unk: n.name }];
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const chain = chainName(n);
        if (chain && /^(import\.meta\.env|process\.env)\./.test(chain)) return [{ unk: chain.split('.').slice(-1)[0] }];
        // param.key -> {param:{index,key}}
        const obj = p.get('object');
        if (obj.isIdentifier()) {
          const b = obj.scope.getBinding(obj.node.name);
          const k = keyName(n);
          if (b?.kind === 'param' && b.scope.block === ctx.fnNode && k != null) {
            const o = paramOrigin(b, k);
            if (o && o.key === k) return [{ param: o }];
          }
          // CONFIG.base
          const target = b && resolveConst(obj);
          const objExpr = target?.isObjectExpression() ? target : null;
          const val = k != null ? getObjProp(objExpr, k) : null;
          if (val) return evalParts(val, ctx, depth + 1);
        }
        return [{ unk: hint(p) }];
      }
      case 'CallExpression': {
        const callee = p.get('callee');
        const cn = chainName(callee.node);
        const last = cn?.split('.').pop();
        if (['encodeURIComponent', 'encodeURI', 'String', 'Number', 'parseInt', 'decodeURIComponent'].includes(cn)) {
          return evalParts(p.get('arguments.0'), ctx, depth + 1);
        }
        if ((callee.isMemberExpression() || callee.isOptionalMemberExpression()) && last) {
          const obj = callee.get('object');
          if (['toString', 'toUpperCase', 'toLowerCase', 'trim', 'replace', 'slice', 'substring', 'at'].includes(last)) {
            return evalParts(obj, ctx, depth + 1);
          }
          if (last === 'concat') {
            const rest = p.get('arguments').flatMap((a) => evalParts(a, ctx, depth + 1));
            return simplify([...evalParts(obj, ctx, depth + 1), ...rest]);
          }
        }
        return [{ unk: hint(p) }];
      }
      case 'NewExpression':
        if (chainName(n.callee) === 'URL') return evalParts(p.get('arguments.0'), ctx, depth + 1);
        return [{ unk: 'param' }];
      default:
        return [{ unk: hint(p) }];
    }
  }

  const methodParts = (parts) => {
    const out = simplify(parts.map((x) => (typeof x === 'string' ? x.toUpperCase() : x)));
    return out;
  };

  // unwrap  JSON.stringify(x) / cond ? x : undefined / a && x
  function unwrapBody(p, depth = 0) {
    if (!p?.node || depth > 5) return p;
    const n = p.node;
    if (t.isCallExpression(n) && chainName(n.callee) === 'JSON.stringify') return unwrapBody(p.get('arguments.0'), depth + 1);
    if (t.isConditionalExpression(n)) {
      const trivial = (x) => t.isNullLiteral(x) || t.isIdentifier(x, { name: 'undefined' }) || (t.isUnaryExpression(x) && x.operator === 'void');
      return unwrapBody(p.get(trivial(n.consequent) ? 'alternate' : 'consequent'), depth + 1);
    }
    if (t.isLogicalExpression(n) && n.operator === '&&') return unwrapBody(p.get('right'), depth + 1);
    if (t.isAwaitExpression(n)) return unwrapBody(p.get('argument'), depth + 1);
    return p;
  }

  function refOf(p, ctx) {
    if (!p?.node) return null;
    const u = unwrapBody(p);
    const n = u.node;
    if (!n || t.isNullLiteral(n) || t.isIdentifier(n, { name: 'undefined' })) return null;
    if (u.isIdentifier()) {
      const b = u.scope.getBinding(n.name);
      if (b?.kind === 'param' && b.scope.block === ctx.fnNode) {
        const o = paramOrigin(b);
        if (o) return { param: o };
      }
    }
    if (u.isMemberExpression() && u.get('object').isIdentifier()) {
      const b = u.scope.getBinding(u.node.object.name);
      const k = keyName(u.node);
      if (b?.kind === 'param' && b.scope.block === ctx.fnNode && k != null) {
        const o = paramOrigin(b, k);
        if (o) return { param: o };
      }
    }
    return { path: u };
  }

  // ---------- request detection ------------------------------------------
  function isAxiosLike(objPath) {
    if (objPath.isIdentifier()) {
      const b = objPath.scope.getBinding(objPath.node.name);
      if (b?.path.isVariableDeclarator()) {
        const init = b.path.node.init;
        if (t.isCallExpression(init)) {
          const cn = chainName(init.callee);
          if (cn && /(^|\.)(create|extend)$/.test(cn) && /axios|ky|got|http|api|client/i.test(cn)) return true;
        }
      }
      return /^(axios|ky|got|superagent|\$http|http|api|client|request|instance|httpClient)$/i.test(objPath.node.name);
    }
    const cn = chainName(objPath.node);
    return !!cn && /(^|\.)(axios|http|api|client)$/i.test(cn);
  }

  function baseRequest(p, ctx) {
    if (!p.isCallExpression()) return null;
    const callee = p.get('callee');
    const args = p.get('arguments');
    const cn = chainName(callee.node);

    // fetch(url, opts)
    if (cn && FETCH_NAMES.has(cn) && !(callee.isIdentifier() && callee.scope.getBinding(callee.node.name))) {
      if (!args[0]) return null;
      const req = {
        kind: 'fetch',
        url: evalParts(args[0], ctx),
        method: ['GET'],
        methodDefault: 'GET',
        body: null,
        headers: null,
        query: null,
        extra: {},
      };
      const opts = args[1];
      if (opts?.node) {
        const obj = resolveConst(opts);
        if (obj.isObjectExpression()) {
          const m = getObjProp(obj, 'method');
          if (m) req.method = evalParts(m, ctx);
          req.body = refOf(getObjProp(obj, 'body'), ctx);
          req.headers = refOf(getObjProp(obj, 'headers'), ctx);
          const cred = getObjProp(obj, 'credentials');
          if (cred?.isStringLiteral()) req.extra.credentials = cred.node.value;
        } else if (opts.isIdentifier()) {
          const b = opts.scope.getBinding(opts.node.name);
          const o = b?.kind === 'param' && b.scope.block === ctx.fnNode ? paramOrigin(b) : null;
          if (o) {
            req.method = [{ param: { index: o.index, key: 'method' } }];
            req.body = { param: { index: o.index, key: 'body' } };
            req.headers = { param: { index: o.index, key: 'headers' } };
          }
        }
      }
      return req;
    }

    // XHR  x.open("POST", url)
    if ((callee.isMemberExpression()) && keyName(callee.node) === 'open' && args.length >= 2 && args[0].isStringLiteral() && HTTP_METHODS.has(args[0].node.value.toUpperCase())) {
      return {
        kind: 'xhr', url: evalParts(args[1], ctx), method: [args[0].node.value.toUpperCase()], methodDefault: 'GET',
        body: null, headers: null, query: null, extra: {},
      };
    }

    // navigator.sendBeacon(url, data)
    if (cn === 'navigator.sendBeacon' && args[0]) {
      return {
        kind: 'beacon', url: evalParts(args[0], ctx), method: ['POST'], methodDefault: 'POST',
        body: refOf(args[1], ctx), headers: null, query: null, extra: {},
      };
    }

    const fromConfig = (cfg, kind, fixedMethod) => {
      const obj = resolveConst(cfg);
      if (!obj.isObjectExpression()) return null;
      const url = getObjProp(obj, 'url');
      if (!url) return null;
      const m = getObjProp(obj, 'method') ?? getObjProp(obj, 'type');
      const base = getObjProp(obj, 'baseURL');
      return {
        kind,
        url: simplify([...(base ? evalParts(base, ctx) : []), ...evalParts(url, ctx)]),
        method: m ? evalParts(m, ctx) : [fixedMethod ?? 'GET'],
        methodDefault: fixedMethod ?? 'GET',
        body: refOf(getObjProp(obj, 'data') ?? getObjProp(obj, 'body'), ctx),
        headers: refOf(getObjProp(obj, 'headers'), ctx),
        query: refOf(getObjProp(obj, 'params'), ctx),
        extra: {},
      };
    };

    // axios({url,...}) / axios(url, cfg)
    if (callee.isIdentifier() && /^(axios|ky|got|\$http)$/i.test(callee.node.name) && args[0]) {
      if (args[0].isObjectExpression()) return fromConfig(args[0], 'axios');
      const req = {
        kind: 'axios', url: evalParts(args[0], ctx), method: ['GET'], methodDefault: 'GET', body: null, headers: null, query: null, extra: {},
      };
      if (args[1]?.isObjectExpression()) {
        const m = getObjProp(args[1], 'method');
        if (m) req.method = evalParts(m, ctx);
        req.body = refOf(getObjProp(args[1], 'data'), ctx);
      }
      return req;
    }

    if (callee.isMemberExpression() || callee.isOptionalMemberExpression()) {
      const prop = keyName(callee.node);
      const obj = callee.get('object');
      // $.ajax({...})
      if (prop === 'ajax' && args[0]?.isObjectExpression()) return fromConfig(args[0], 'ajax');
      // client.request({ url, method })
      if (prop === 'request' && args[0]?.isObjectExpression() && isAxiosLike(obj)) return fromConfig(args[0], 'axios');
      // client.get(url) ...
      if (VERBS.has(prop) && args[0] && !args[0].isSpreadElement()) {
        const url = evalParts(args[0], ctx);
        const known = isAxiosLike(obj);
        const joined = url.map((x) => (typeof x === 'string' ? x : '')).join('');
        const looksUrl = /^(https?:)?\/\//.test(joined) || joined.startsWith('/') || (known && joined.length > 0) || (known && hasParam(url));
        if (!looksUrl && !(known && url.length)) return null;
        const method = prop.toUpperCase();
        const req = {
          kind: 'axios', url, method: [method], methodDefault: method, body: null, headers: null, query: null, extra: {},
        };
        const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);
        const cfgIdx = hasBody ? 2 : 1;
        if (hasBody) req.body = refOf(args[1], ctx);
        const cfg = args[cfgIdx] ? resolveConst(args[cfgIdx]) : null;
        if (cfg?.isObjectExpression()) {
          req.query = refOf(getObjProp(cfg, 'params'), ctx);
          req.headers = refOf(getObjProp(cfg, 'headers'), ctx);
          if (!hasBody) req.body = refOf(getObjProp(cfg, 'data'), ctx);
        }
        return req;
      }
    }
    return null;
  }

  function argFor(callPath, ref, ctx) {
    const arg = callPath.get('arguments')[ref.index];
    if (!arg?.node || arg.isSpreadElement()) return null;
    if (ref.key == null) return arg;
    const obj = resolveConst(arg);
    if (obj.isObjectExpression()) return getObjProp(obj, ref.key);
    if (arg.isIdentifier()) {
      const b = arg.scope.getBinding(arg.node.name);
      const o = b?.kind === 'param' && b.scope.block === ctx.fnNode ? paramOrigin(b) : null;
      if (o && o.key == null) return { param: { index: o.index, key: ref.key } };
    }
    return null;
  }

  function wrapperRequest(p, ctx) {
    if (!p.isCallExpression()) return null;
    const spec = specFor(p.get('callee'));
    if (!spec) return null;
    const sub = (parts) => {
      const out = [];
      for (const it of parts) {
        if (typeof it === 'string' || it.unk) out.push(it);
        else if (it.param) {
          const r = argFor(p, it.param, ctx);
          if (!r) {
            if (p.node.arguments[it.param.index]) out.push({ unk: it.param.key ?? it.param.name ?? `arg${it.param.index}` });
            continue;
          }
          if (r.param) out.push(r);
          else out.push(...evalParts(r, ctx));
        }
      }
      return simplify(out);
    };
    const subRef = (ref) => {
      if (!ref) return null;
      if (ref.path) return ref;
      const r = argFor(p, ref.param, ctx);
      if (!r) return null;
      if (r.param) return r;
      return refOf(r, ctx);
    };
    const method = sub(spec.method);
    return {
      kind: spec.kind,
      url: sub(spec.url),
      method: method.length ? method : [spec.methodDefault],
      methodDefault: spec.methodDefault,
      body: subRef(spec.body),
      headers: subRef(spec.headers),
      query: subRef(spec.query),
      extra: spec.extra ?? {},
      viaWrapper: true,
    };
  }

  const fn0 = (p) => fnOf(p);
  const ctxOf = (p) => ({ fnNode: fnOf(p)?.node ?? null });
  const requestOf = (p) => {
    const ctx = ctxOf(p);
    return baseRequest(p, ctx) ?? wrapperRequest(p, ctx);
  };

  // ---------- fixed point: discover transport wrappers --------------------
  const sinkNodes = new Set();
  for (let round = 0; round < 6; round++) {
    let changed = false;
    for (const p of calls) {
      if (!p.isCallExpression()) continue;
      const req = requestOf(p);
      if (!req) continue;
      if (!(hasParam(req.url) || hasParam(req.method) || req.body?.param || req.headers?.param || req.query?.param)) continue;
      const fn = fnOf(p);
      const info = fnInfo(fn);
      if (!info) continue;
      const spec = { ...req, fnNode: fn.node };
      delete spec.viaWrapper;
      if (info.binding) {
        if (!byBinding.has(info.binding)) {
          byBinding.set(info.binding, spec);
          sinkNodes.add(fn.node);
          changed = true;
        }
      } else {
        let m = byProp.get(info.objBinding);
        if (!m) byProp.set(info.objBinding, (m = new Map()));
        if (!m.has(info.key)) {
          m.set(info.key, spec);
          sinkNodes.add(fn.node);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  // ---------- value -> consumed fields (response shape) -------------------
  function responseFields(callPath) {
    const out = new Set();
    const seen = new Set();
    const record = (segs) => {
      const s = segs.join('.').replace(/\.\[\]/g, '[]');
      if (s && !SKIP_PROPS.has(s)) out.add(s);
    };
    const isMember = (p) => p?.isMemberExpression() || p?.isOptionalMemberExpression();

    function patternFields(pat, prefix, depth) {
      if (!pat.isObjectPattern() || depth > 6) return;
      for (const prop of pat.get('properties')) {
        if (!prop.isObjectProperty()) continue;
        const k = keyName(prop.node);
        if (k == null) continue;
        let v = prop.get('value');
        if (v.isAssignmentPattern()) v = v.get('left');
        const here = [...prefix, k];
        if (v.isObjectPattern()) patternFields(v, here, depth + 1);
        else if (v.isIdentifier()) {
          const before = out.size;
          trackBinding(v.scope.getBinding(v.node.name), here, depth + 1);
          if (out.size === before || true) record(here);
        } else record(here);
      }
    }

    function trackBinding(b, prefix, depth) {
      if (!b || depth > 6 || seen.has(b)) return;
      seen.add(b);
      for (const ref of b.referencePaths) walk(ref, prefix, depth + 1);
    }

    function trackCallbackParam(cb, prefix, depth) {
      if (!cb?.node || !cb.isFunction()) return;
      const prm = cb.get('params.0');
      if (!prm?.node) return;
      if (prm.isIdentifier()) trackBinding(cb.scope.getBinding(prm.node.name), prefix, depth + 1);
      else if (prm.isObjectPattern()) patternFields(prm, prefix, depth + 1);
    }

    function walk(p, prefix, depth) {
      if (depth > 8) return;
      const parent = p.parentPath;
      if (!parent) return;
      if (parent.isAwaitExpression() || parent.isParenthesizedExpression?.() || parent.isTSNonNullExpression?.()) {
        return walk(parent, prefix, depth + 1);
      }
      if (parent.isVariableDeclarator() && parent.node.init === p.node) {
        const id = parent.get('id');
        if (id.isIdentifier()) trackBinding(parent.scope.getBinding(id.node.name), prefix, depth + 1);
        else patternFields(id, prefix, depth + 1);
        return;
      }
      if (parent.isAssignmentExpression() && parent.node.right === p.node && parent.get('left').isIdentifier()) {
        const b = parent.scope.getBinding(parent.node.left.name);
        if (b) trackBinding(b, prefix, depth + 1);
        return;
      }
      if (isMember(parent) && parent.node.object === p.node) {
        const k = keyName(parent.node);
        const call = parent.parentPath;
        const isCall = call && (call.isCallExpression() || call.isOptionalCallExpression?.()) && call.node.callee === parent.node;
        if (isCall) {
          if (k === 'json' || k === 'catch' || k === 'finally') return walk(call, prefix, depth + 1);
          if (k === 'then') {
            const cb = call.get('arguments.0');
            if (cb?.node && cb.isFunction()) {
              // .then(r => r.json())
              const prm = cb.get('params.0');
              const body = cb.get('body');
              const retJson =
                body.isCallExpression() && isMember(body.get('callee')) && keyName(body.node.callee) === 'json' &&
                prm?.isIdentifier() && body.node.callee.object?.name === prm.node.name;
              if (retJson) return walk(call, prefix, depth + 1);
              trackCallbackParam(cb, prefix, depth + 1);
              // value returned by the callback feeds the next link of the chain
              const next = call.parentPath;
              if (isMember(next) && next.node.object === call.node) walk(call, prefix, depth + 1);
            } else if (cb?.isIdentifier()) {
              // .then(setItems) : nothing we can track
            }
            return;
          }
          if (ARRAY_METHODS.has(k)) {
            trackCallbackParam(call.get('arguments.0'), [...prefix, '[]'], depth + 1);
          }
          return;
        }
        // property read: climb the chain
        const keys = [...prefix];
        let cur = p;
        let m = parent;
        while (m) {
          const kk = keyName(m.node);
          const c = m.parentPath;
          const isMethodCall = c && c.isCallExpression() && c.node.callee === m.node;
          if (isMethodCall) {
            if (ARRAY_METHODS.has(kk)) {
              record(keys);
              trackCallbackParam(c.get('arguments.0'), [...keys, '[]'], depth + 1);
              return;
            }
            record(keys);
            return;
          }
          if (kk == null) keys.push('[]');
          else if (kk === 'length') {
            record(keys);
            return;
          } else keys.push(/^\d+$/.test(kk) ? '[]' : kk);
          cur = m;
          const up = m.parentPath;
          if (isMember(up) && up.node.object === m.node && keys.length < 8) m = up;
          else {
            // x.a.b = ...  (write) is not a response read
            if (up?.isAssignmentExpression() && up.node.left === m.node) return;
            break;
          }
        }
        record(keys);
        // `const y = x.a.b`  -> keep following
        const holder = cur.parentPath;
        if (holder?.isVariableDeclarator() && holder.node.init === cur.node && t.isIdentifier(holder.node.id)) {
          trackBinding(holder.scope.getBinding(holder.node.id.name), keys, depth + 1);
        }
        return;
      }
      // returned from a function -> follow that function's call sites
      const ret = parent.isReturnStatement() || (parent.isArrowFunctionExpression() && parent.node.body === p.node);
      if (ret) {
        const fn = parent.isArrowFunctionExpression() ? parent : p.getFunctionParent();
        for (const site of callSitesOf(fn).slice(0, 25)) walk(site, prefix, depth + 1);
      }
    }

    walk(callPath, [], 0);
    return [...out].sort();
  }

  // ---------- body / query field extraction -------------------------------
  function typeOf(p, depth = 0) {
    if (!p?.node || depth > 3) return 'any';
    const n = p.node;
    switch (n.type) {
      case 'StringLiteral':
      case 'TemplateLiteral':
        return 'string';
      case 'NumericLiteral':
        return 'number';
      case 'BooleanLiteral':
        return 'boolean';
      case 'NullLiteral':
        return 'null';
      case 'ArrayExpression':
        return 'array';
      case 'ObjectExpression':
        return 'object';
      case 'UnaryExpression':
        return n.operator === '!' ? 'boolean' : n.operator === '+' || n.operator === '-' ? 'number' : 'any';
      case 'LogicalExpression': {
        if (n.operator === '??' || n.operator === '||') {
          const l = typeOf(p.get('left'), depth + 1);
          const r = typeOf(p.get('right'), depth + 1);
          if (r === 'null' || r === 'undefined') return l === 'any' ? 'any|null' : `${l}|null`;
          return l === 'any' ? r : l;
        }
        return 'boolean';
      }
      case 'ConditionalExpression':
        return typeOf(p.get('consequent'), depth + 1);
      case 'CallExpression': {
        const cn = chainName(n.callee);
        if (cn === 'Boolean') return 'boolean';
        if (['Number', 'parseInt', 'parseFloat'].includes(cn)) return 'number';
        if (cn === 'String' || cn === 'JSON.stringify') return 'string';
        if (cn?.endsWith('.trim') || cn?.endsWith('.toString')) return 'string';
        return 'any';
      }
      case 'Identifier': {
        if (n.name === 'undefined') return 'undefined';
        const b = p.scope.getBinding(n.name);
        if (b?.constant && b.path.isVariableDeclarator() && b.path.node.init) return typeOf(b.path.get('init'), depth + 1);
        return 'any';
      }
      default:
        return 'any';
    }
  }

  function fieldsOfObject(obj, prefix, out, depth, optional = false) {
    if (depth > 4) return;
    for (const prop of obj.get('properties')) {
      if (prop.isObjectProperty()) {
        const k = keyName(prop.node);
        if (k == null) continue;
        const v = prop.get('value');
        const name = prefix ? `${prefix}.${k}` : k;
        const inner = resolveConst(v);
        if (inner.isObjectExpression()) {
          out.push({ name, type: 'object', ...(optional ? { optional: true } : {}) });
          fieldsOfObject(inner, name, out, depth + 1, optional);
        } else {
          out.push({ name, type: typeOf(v), ...(optional ? { optional: true } : {}) });
        }
      } else if (prop.isSpreadElement()) {
        const arg = resolveConst(prop.get('argument'));
        if (arg.isObjectExpression()) fieldsOfObject(arg, prefix, out, depth + 1, optional);
        else if (arg.isConditionalExpression() || arg.isLogicalExpression()) {
          for (const side of arg.isLogicalExpression() ? [arg.get('right')] : [arg.get('consequent'), arg.get('alternate')]) {
            const o = resolveConst(side);
            if (o.isObjectExpression()) fieldsOfObject(o, prefix, out, depth + 1, true);
          }
        }
      }
    }
  }

  function fieldsOf(ref) {
    if (!ref || ref.param || !ref.path) return { fields: [], note: ref?.param ? 'passthrough' : undefined };
    const p = resolveConst(ref.path);
    const out = [];
    if (p.isObjectExpression()) {
      fieldsOfObject(p, '', out, 0);
      return { fields: out };
    }
    if (p.isNewExpression() && chainName(p.node.callee) === 'FormData') {
      const names = [];
      // appended entries on the binding that holds the FormData
      const decl = p.parentPath;
      if (decl?.isVariableDeclarator() && t.isIdentifier(decl.node.id)) {
        const b = decl.scope.getBinding(decl.node.id.name);
        for (const r of b?.referencePaths ?? []) {
          const m = r.parentPath;
          if (m?.isMemberExpression() && keyName(m.node) === 'append') {
            const [first, second] = m.parentPath.node.arguments ?? [];
            if (t.isStringLiteral(first)) {
              names.push({ name: first.value, type: t.isStringLiteral(second) || t.isTemplateLiteral(second) ? 'string' : 'string|file' });
            }
          }
        }
      }
      return { fields: names, contentType: 'multipart/form-data' };
    }
    if (p.isIdentifier()) {
      const b = p.scope.getBinding(p.node.name);
      if (b?.path.isVariableDeclarator() && b.path.node.init && t.isNewExpression(b.path.node.init) && chainName(b.path.node.init.callee) === 'FormData') {
        return fieldsOf({ path: b.path.get('init') });
      }
    }
    return { fields: [], note: p.isIdentifier() ? `variable ${p.node.name}` : undefined };
  }

  function headerKeys(ref) {
    if (!ref?.path) return [];
    const p = resolveConst(ref.path);
    if (!p.isObjectExpression()) return [];
    const out = [];
    for (const prop of p.get('properties')) {
      if (!prop.isObjectProperty()) continue;
      const k = keyName(prop.node);
      if (k == null) continue;
      const v = prop.get('value');
      out.push({ name: k, value: v.isStringLiteral() ? v.node.value : null });
    }
    return out;
  }

  // ---------- final pass --------------------------------------------------
  const endpoints = new Map();
  const dynamic = [];
  const realtime = [];
  const appStatements = new Set();
  const topStatement = (p) => p.findParent((x) => x.parentPath?.isProgram())?.node ?? null;

  const contextOf = (p) => {
    let fn = fnOf(p);
    let first = null;
    for (let i = 0; i < 4 && fn; i++) {
      const info = fnInfo(fn);
      if (info) {
        first ??= info.name;
        if (info.name.replace(/^.*\./, '').length > 2) return info.name;
      }
      fn = fn.getFunctionParent();
    }
    return first;
  };

  for (const p of calls) {
    if (p.isNewExpression()) {
      const cn = chainName(p.node.callee);
      if (cn === 'WebSocket' || cn === 'EventSource') {
        const url = evalParts(p.get('arguments.0'), ctxOf(p));
        realtime.push({ type: cn === 'WebSocket' ? 'websocket' : 'sse', url: patternOf(url), context: contextOf(p), loc: locOf(p.node) });
        const st = topStatement(p);
        if (st) appStatements.add(st);
      }
      continue;
    }
    const req = requestOf(p);
    if (!req) continue;

    const staticText = req.url.some((x) => typeof x === 'string' && x.length > 0);
    const params = hasParam(req.url);
    const st = topStatement(p);
    if (params && !staticText) continue; // generic transport body, call sites carry the info
    if (!staticText) {
      dynamic.push({ url: patternOf(req.url), context: contextOf(p), kind: req.kind, loc: locOf(p.node) });
      if (st) appStatements.add(st);
      continue;
    }
    if (st) appStatements.add(st);

    const methodStr = patternOf(methodParts(req.method)).toUpperCase().replace(/[{}]/g, '');
    const method = HTTP_METHODS.has(methodStr) ? methodStr : req.methodDefault ?? 'GET';
    const urlPattern = patternOf(req.url);
    const key = `${method} ${urlPattern.split('?')[0].replace(/\{[^}]*\}/g, '{}')}`;

    const body = fieldsOf(req.body);
    // body is a parameter of a client method: learn its shape from the callers
    if (req.body?.param) {
      for (const site of callSitesOf(fn0(p)).slice(0, 25)) {
        const a = argFor(site, req.body.param, ctxOf(site));
        if (!a || a.param || !a.node) continue;
        const sub = fieldsOf({ path: unwrapBody(a) });
        for (const f of sub.fields) if (!body.fields.some((x) => x.name === f.name)) body.fields.push(f);
        body.contentType ??= sub.contentType;
        if (sub.fields.length) body.note = undefined;
      }
    }
    const queryObj = fieldsOf(req.query);
    const fn = fnOf(p);
    let streaming = false;
    fn?.traverse({
      Identifier(ip) {
        if (ip.node.name === 'getReader') streaming = true;
      },
      StringLiteral(sp) {
        if (/text\/event-stream/.test(sp.node.value)) streaming = true;
      },
    });

    // query string from the URL itself
    const q = [];
    const qi = urlPattern.indexOf('?');
    let pathOnly = urlPattern;
    if (qi >= 0) {
      pathOnly = urlPattern.slice(0, qi);
      for (const kv of urlPattern.slice(qi + 1).split('&')) {
        const [k, v] = kv.split('=');
        if (k) q.push({ name: k, type: v && !/^\{/.test(v) ? 'string' : 'any', ...(v?.startsWith('{') ? {} : { example: v }) });
      }
    }
    for (const f of queryObj.fields) if (!q.some((x) => x.name === f.name)) q.push(f);

    const entry = {
      method,
      path: pathOnly,
      url: urlPattern,
      via: req.kind,
      context: contextOf(p),
      loc: locOf(p.node),
      query: q,
      body: body.fields,
      bodyNote: body.note,
      contentType: body.contentType ?? (body.fields.length ? 'application/json' : undefined),
      headers: headerKeys(req.headers),
      credentials: req.extra?.credentials,
      streaming: streaming || undefined,
      response: responseFields(p).filter((f) => req.viaWrapper || req.kind !== 'fetch' || !RESPONSE_PROPS.has(f)),
      callSites: 1,
    };

    const prev = endpoints.get(key);
    if (!prev) endpoints.set(key, entry);
    else {
      prev.callSites++;
      for (const f of entry.body) if (!prev.body.some((x) => x.name === f.name)) prev.body.push(f);
      for (const f of entry.query) if (!prev.query.some((x) => x.name === f.name)) prev.query.push(f);
      prev.response = [...new Set([...prev.response, ...entry.response])].sort();
      prev.streaming ||= entry.streaming;
      prev.contexts = [...new Set([...(prev.contexts ?? [prev.context]), entry.context])].filter(Boolean);
    }
  }

  const list = mergeConcrete([...endpoints.values()]);
  return { endpoints: list, dynamic, realtime, sinkNodes, appStatements };
}

/**
 * `/users/7` is just a call of `/users/{id}`: fold concrete paths into a matching templated one.
 */
export function mergeConcrete(list) {
  const templated = list.filter((e) => /\{[^}]*\}/.test(e.path));
  const out = [];
  for (const e of list) {
    const isConcrete = !/\{[^}]*\}/.test(e.path);
    const target = isConcrete
      ? templated.find((t2) => {
          if (t2.method !== e.method || t2 === e) return false;
          const re = new RegExp(`^${t2.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]*\}/g, '[^/]+')}$`);
          return re.test(e.path);
        })
      : null;
    if (!target) {
      out.push(e);
      continue;
    }
    target.callSites += e.callSites;
    for (const f of e.body) if (!target.body.some((x) => x.name === f.name)) target.body.push(f);
    for (const f of e.query) if (!target.query.some((x) => x.name === f.name)) target.query.push(f);
    target.response = [...new Set([...target.response, ...e.response])].sort();
    target.streaming ||= e.streaming;
  }
  return out;
}

function empty() {
  return { endpoints: [], dynamic: [], realtime: [], sinkNodes: new Set(), appStatements: new Set() };
}

/** Render parts to a URL pattern with readable placeholder names. */
export function patternOf(parts) {
  let out = '';
  for (const it of parts) {
    if (typeof it === 'string') out += it;
    else if (it.param) out += `{${it.param.key ?? it.param.name ?? `arg${it.param.index}`}}`;
    else out += `{${isIdentName(it.unk) || /^[\w$.]+$/.test(it.unk) ? it.unk : 'param'}}`;
  }
  return improvePlaceholders(out);
}

const singular = (s) => (s.endsWith('ies') ? `${s.slice(0, -3)}y` : s.endsWith('s') && !s.endsWith('ss') ? s.slice(0, -1) : s);

function improvePlaceholders(s) {
  return s.replace(/\{([^}]*)\}/g, (m, name, offset) => {
    if (name.length > 2 && name !== 'param') return m;
    const before = s.slice(0, offset);
    const kv = /([A-Za-z0-9_.-]+)=$/.exec(before);
    if (kv) return `{${kv[1]}}`;
    const seg = /\/([A-Za-z0-9_-]+)\/$/.exec(before);
    if (seg) {
      if (/^(api|v\d+)$/.test(seg[1])) return '{id}';
      return `{${singular(seg[1])}Id}`;
    }
    return m;
  });
}
