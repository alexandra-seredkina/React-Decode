import { traverse, t, isIdentName, chainName, keyName } from './ast.js';

const SHORT = /^[A-Za-z_$][A-Za-z0-9_$]?$/;
const isShort = (n) => SHORT.test(n) || /^[A-Za-z_$]{1,3}$/.test(n);

const REACT_HOOKS = new Set([
  'useState', 'useEffect', 'useLayoutEffect', 'useRef', 'useMemo', 'useCallback', 'useContext', 'useReducer',
  'createElement', 'createContext', 'forwardRef', 'memo', 'Fragment', 'useId', 'useTransition', 'lazy', 'Suspense',
]);

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const upperFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const pascal = (s) =>
  s
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^[^A-Za-z]+/, '')
    .replace(/^./, (c) => c.toUpperCase());

function initHint(init) {
  if (!init) return 'value';
  switch (init.type) {
    case 'StringLiteral':
    case 'TemplateLiteral':
      return 'text';
    case 'BooleanLiteral':
      return 'flag';
    case 'NumericLiteral':
      return 'count';
    case 'ArrayExpression':
      return 'items';
    case 'ObjectExpression':
      return 'data';
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return 'fn';
    case 'UnaryExpression':
      return init.operator === '!' ? 'flag' : 'value';
    default:
      return 'value';
  }
}

/** Name for the result of a call/new expression, or null. */
function nameForInit(init) {
  if (!init) return null;
  let node = init;
  if (t.isAwaitExpression(node)) {
    const inner = node.argument;
    if (t.isCallExpression(inner)) {
      const prop = t.isMemberExpression(inner.callee) ? keyName(inner.callee) : null;
      if (prop === 'json') return 'data';
      if (prop === 'text') return 'text';
      if (prop === 'blob') return 'blob';
      if (t.isIdentifier(inner.callee, { name: 'fetch' }) || prop === 'fetch') return 'response';
    }
    node = inner;
  }
  if (t.isNewExpression(node) && t.isIdentifier(node.callee)) {
    const n = node.callee.name;
    const map = {
      URLSearchParams: 'params', FormData: 'formData', AbortController: 'controller', Date: 'date', Map: 'map',
      Set: 'set', WebSocket: 'socket', EventSource: 'eventSource', Error: 'error', URL: 'url', Blob: 'blob',
      FileReader: 'reader', Image: 'image', Audio: 'audio', IntersectionObserver: 'observer', ResizeObserver: 'observer',
      MutationObserver: 'observer', XMLHttpRequest: 'xhr', TextDecoder: 'decoder', TextEncoder: 'encoder', Promise: 'promise',
    };
    return map[n] ?? (isIdentName(n) && n.length > 3 ? lowerFirst(n) : null);
  }
  if (t.isCallExpression(node)) {
    const chain = chainName(node.callee);
    const last = chain?.split('.').pop();
    if (!last) return null;
    if (/^use[A-Z]/.test(last)) return lowerFirst(last.slice(3));
    const table = {
      createContext: 'context', getElementById: 'element', querySelector: 'element', createElement: 'element',
      getItem: 'stored', parse: chain === 'JSON.parse' ? 'parsed' : null, stringify: chain === 'JSON.stringify' ? 'json' : null,
      fetch: 'responsePromise', entries: 'entries', keys: 'keys', values: 'values', now: 'now', random: 'random',
      createRef: 'ref', getReader: 'reader', createObjectURL: 'objectUrl', matchMedia: 'mediaQuery',
    };
    if (table[last]) return table[last];
    if (last === 'json') return 'data';
  }
  return null;
}

class Renamer {
  constructor(ast, sinkNodes) {
    this.ast = ast;
    this.sinkNodes = sinkNodes ?? new Set();
    this.map = []; // {scope, from, to, reason}
    this.used = new Set();
    this.componentNames = new Set();
  }

  unique(scope, base) {
    let name = isIdentName(base) ? base : `${base}_`;
    let i = 1;
    const taken = (n) => scope.hasBinding(n) || scope.hasGlobal(n) || scope.hasReference(n) || this.used.has(n);
    while (taken(name)) name = `${base}${++i}`;
    return name;
  }

  rename(binding, to, reason) {
    if (!binding || !to) return;
    const from = binding.identifier.name;
    if (from === to) return;
    const scope = binding.scope;
    const unique = this.unique(scope, to);
    scope.rename(from, unique);
    this.map.push({ from, to: unique, reason });
  }

  run() {
    this.reactNamespaces();
    this.destructuring();
    this.hooksAndInits();
    this.paramsFromKeys();
    this.callbackParams();
    this.functions();
  }

  reactNamespaces() {
    const self = this;
    const hits = new Map();
    traverse(this.ast, {
      MemberExpression(path) {
        const { object, property } = path.node;
        if (!t.isIdentifier(object) || path.node.computed || !t.isIdentifier(property)) return;
        const b = path.scope.getBinding(object.name);
        if (!b) return;
        const rec = hits.get(b) ?? { react: 0, jsx: 0 };
        if (REACT_HOOKS.has(property.name)) rec.react++;
        if (property.name === 'jsx' || property.name === 'jsxs' || property.name === 'jsxDEV') rec.jsx++;
        hits.set(b, rec);
      },
    });
    for (const [b, rec] of hits) {
      if (!isShort(b.identifier.name)) continue;
      if (rec.jsx > rec.react) self.rename(b, 'jsxRuntime', 'jsx runtime namespace');
      else if (rec.react >= 2) self.rename(b, 'React', 'react namespace');
    }
  }

  destructuring() {
    const pending = [];
    traverse(this.ast, {
      ObjectPattern(path) {
        for (const prop of path.node.properties) {
          if (!t.isObjectProperty(prop) || prop.computed) continue;
          const key = keyName(prop);
          if (!isIdentName(key)) continue;
          let id = prop.value;
          if (t.isAssignmentPattern(id)) id = id.left;
          if (!t.isIdentifier(id) || id.name === key || !isShort(id.name)) continue;
          pending.push({ scope: path.scope, id, key });
        }
      },
    });
    for (const { scope, id, key } of pending) {
      const b = scope.getBinding(id.name);
      if (b && b.identifier === id) this.rename(b, key, 'destructured key');
    }
  }

  hooksAndInits() {
    const pending = [];
    traverse(this.ast, {
      VariableDeclarator(path) {
        const { id, init } = path.node;
        if (!init) return;
        if (t.isArrayPattern(id) && t.isCallExpression(init)) {
          const hook = chainName(init.callee)?.split('.').pop();
          if (hook === 'useState' && id.elements.length >= 1) {
            const hint = initHint(init.arguments[0]);
            pending.push({ scope: path.scope, id: id.elements[0], to: hint, reason: 'useState value' });
            pending.push({ scope: path.scope, id: id.elements[1], to: `set${upperFirst(hint)}`, reason: 'useState setter' });
          } else if (hook === 'useReducer') {
            pending.push({ scope: path.scope, id: id.elements[0], to: 'state', reason: 'useReducer' });
            pending.push({ scope: path.scope, id: id.elements[1], to: 'dispatch', reason: 'useReducer' });
          } else if (hook && /^use[A-Z]/.test(hook)) {
            const base = lowerFirst(hook.slice(3));
            pending.push({ scope: path.scope, id: id.elements[0], to: base, reason: hook });
            pending.push({ scope: path.scope, id: id.elements[1], to: `set${upperFirst(base)}`, reason: hook });
          }
          return;
        }
        if (t.isIdentifier(id) && isShort(id.name)) {
          const to = nameForInit(init);
          if (to) pending.push({ scope: path.scope, id, to, reason: 'initializer' });
        }
      },
      CatchClause(path) {
        const p = path.node.param;
        if (t.isIdentifier(p) && isShort(p.name)) pending.push({ scope: path.scope, id: p, to: 'error', reason: 'catch param' });
      },
    });
    for (const { scope, id, to, reason } of pending) {
      if (!t.isIdentifier(id) || !isShort(id.name)) continue;
      const b = scope.getBinding(id.name);
      if (b && b.identifier === id) this.rename(b, to, reason);
    }
  }

  /** `(e, t) => request({ code: e, mode: t })`  ->  `(code, mode) => ...` */
  paramsFromKeys() {
    const pending = [];
    traverse(this.ast, {
      ObjectProperty(path) {
        const { node } = path;
        if (node.computed || !path.parentPath.isObjectExpression()) return;
        const key = keyName(node);
        if (!isIdentName(key)) return;
        let v = node.value;
        if (t.isLogicalExpression(v) && (v.operator === '??' || v.operator === '||')) v = v.left;
        if (!t.isIdentifier(v) || v.name === key || !isShort(v.name)) return;
        const b = path.scope.getBinding(v.name);
        if (b && b.kind === 'param' && b.referencePaths.length === 1) pending.push({ b, to: key });
      },
    });
    for (const { b, to } of pending) {
      if (isShort(b.identifier.name)) this.rename(b, to, 'object key');
    }
  }

  callbackParams() {
    const pending = [];
    traverse(this.ast, {
      Function(path) {
        path.node.params.forEach((param, index) => {
          if (!t.isIdentifier(param) || !isShort(param.name)) return;
          const b = path.scope.getBinding(param.name);
          if (!b || b.identifier !== param) return;
          const props = new Set();
          for (const ref of b.referencePaths) {
            const p = ref.parentPath;
            if (p?.isMemberExpression() && p.node.object === ref.node) props.add(keyName(p.node));
          }
          let to = null;
          if (index === 0 && ['preventDefault', 'stopPropagation', 'target', 'currentTarget', 'key', 'clientX', 'nativeEvent'].some((k) => props.has(k))) to = 'event';
          else if (props.has('current') && props.size === 1) to = 'ref';
          else if (props.has('ok') && props.has('json')) to = 'response';
          if (to) pending.push({ b, to });
        });
      },
    });
    for (const { b, to } of pending) this.rename(b, to, 'usage');
  }

  functions() {
    const self = this;
    const pending = [];
    traverse(this.ast, {
      Program(path) {
        for (const stmt of path.get('body')) {
          const decl = stmt.isExportNamedDeclaration() ? stmt.get('declaration') : stmt;
          if (!decl.node) continue;
          if (decl.isFunctionDeclaration()) {
            const name = decl.node.id?.name;
            const b = name && decl.scope.getBinding(name);
            if (b) self.classifyFunction(b, decl, pending);
          } else if (decl.isVariableDeclaration()) {
            for (const d of decl.get('declarations')) {
              const id = d.node.id;
              const init = d.get('init');
              if (!t.isIdentifier(id) || !init.node) continue;
              const b = d.scope.getBinding(id.name);
              if (!b) continue;
              if (init.isFunction()) self.classifyFunction(b, init, pending);
              else if (init.isObjectExpression()) self.classifyObject(b, init, pending);
              else if (init.isCallExpression()) {
                const last = chainName(init.node.callee)?.split('.').pop();
                if (last === 'createContext') pending.push({ b, to: `${pascal(id.name)}Context`, reason: 'createContext' });
                else if (last === 'lazy' || last === 'memo' || last === 'forwardRef') {
                  const inner = init.get('arguments.0');
                  if (inner.node && inner.isFunction() && self.looksLikeComponent(inner)) {
                    pending.push({ b, to: self.componentName(inner), reason: last });
                  }
                }
              }
            }
          } else if (decl.isClassDeclaration() && decl.node.id && isShort(decl.node.id.name)) {
            const b = decl.scope.getBinding(decl.node.id.name);
            const sup = chainName(decl.node.superClass);
            if (b) pending.push({ b, to: sup ? `${pascal(sup.split('.').pop())}Subclass` : 'Class', reason: 'class' });
          }
        }
      },
    });
    for (const p of pending) {
      if (isShort(p.b.identifier.name)) this.rename(p.b, p.to, p.reason);
    }
  }

  classifyFunction(binding, fnPath, pending) {
    if (!isShort(binding.identifier.name)) return;
    if (this.sinkNodes.has(fnPath.node)) {
      pending.push({ b: binding, to: 'httpRequest', reason: 'http transport wrapper' });
      return;
    }
    if (this.looksLikeComponent(fnPath)) {
      pending.push({ b: binding, to: this.componentName(fnPath), reason: 'component' });
      return;
    }
    // custom hook: calls React hooks, no JSX
    let hooks = 0;
    fnPath.traverse({
      CallExpression(p) {
        const last = chainName(p.node.callee)?.split('.').pop();
        if (last && /^use[A-Z]/.test(last) && REACT_HOOKS.has(last)) hooks++;
      },
    });
    if (hooks >= 1) pending.push({ b: binding, to: 'useCustomHook', reason: 'custom hook' });
  }

  classifyObject(binding, objPath, pending) {
    if (!isShort(binding.identifier.name)) return;
    const props = objPath.node.properties;
    const fnProps = props.filter(
      (p) => (t.isObjectProperty(p) && (t.isArrowFunctionExpression(p.value) || t.isFunctionExpression(p.value))) || t.isObjectMethod(p),
    );
    if (fnProps.length >= 3 && fnProps.length >= props.length * 0.6) {
      let http = 0;
      const sinks = this.sinkNodes;
      objPath.traverse({
        CallExpression(p) {
          const callee = p.node.callee;
          if (!t.isIdentifier(callee)) return;
          const b = p.scope.getBinding(callee.name);
          const n = b?.path.isFunctionDeclaration() ? b.path.node : b?.path.node?.init;
          if (n && sinks.has(n)) http++;
        },
      });
      if (http >= 2) pending.push({ b: binding, to: 'api', reason: 'api client object' });
    }
  }

  looksLikeComponent(fnPath) {
    let jsx = 0;
    const own = fnPath.node;
    fnPath.traverse({
      CallExpression(p) {
        const callee = p.node.callee;
        if (t.isMemberExpression(callee) && !callee.computed && ['jsx', 'jsxs', 'jsxDEV', 'createElement'].includes(callee.property.name)) {
          if (p.getFunctionParent()?.node === own) jsx++;
        } else if (t.isIdentifier(callee) && ['jsx', 'jsxs', '_jsx', '_jsxs'].includes(callee.name)) jsx++;
      },
      JSXElement(p) {
        if (p.getFunctionParent()?.node === own) jsx++;
      },
    });
    return jsx > 0;
  }

  componentName(fnPath) {
    let found = null;
    fnPath.traverse({
      ObjectProperty(p) {
        if (found) return;
        if (keyName(p.node) !== 'className') return;
        const v = p.node.value;
        if (t.isStringLiteral(v)) found = v.value;
        else if (t.isTemplateLiteral(v)) found = v.quasis[0].value.cooked;
      },
    });
    let base = found ? pascal(found.trim().split(/\s+/)[0]) : '';
    if (!base || base.length < 2) base = 'Component';
    return base;
  }
}

export function renameIdentifiers(ast, { sinkNodes } = {}) {
  const r = new Renamer(ast, sinkNodes);
  r.run();
  traverse(ast, {
    ObjectProperty(path) {
      const { node } = path;
      if (node.computed || node.shorthand || !t.isIdentifier(node.key)) return;
      const v = t.isAssignmentPattern(node.value) ? node.value.left : node.value;
      if (t.isIdentifier(v) && v.name === node.key.name) node.shorthand = true;
    },
  });
  return r.map;
}
