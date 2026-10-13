import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import * as generatorModule from '@babel/generator';
import * as t from '@babel/types';

export const traverse = traverseModule.default ?? traverseModule;
const gen = generatorModule.generate ?? generatorModule.default;
export { t };

export function parseSource(code, filename = '') {
  const ts = /\.(tsx?|mts|cts)$/.test(filename);
  const plugins = ts ? ['jsx', 'typescript'] : ['jsx'];
  const opts = {
    sourceType: 'unambiguous',
    errorRecovery: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowSuperOutsideMethod: true,
    allowUndeclaredExports: true,
    plugins,
  };
  try {
    return parse(code, opts);
  } catch (err) {
    // JSX plugin can choke on exotic compiled output; retry without it.
    if (ts) throw err;
    return parse(code, { ...opts, plugins: [] });
  }
}

export function generate(ast, opts = {}) {
  return gen(ast, { comments: true, jsescOption: { minimal: true }, ...opts }).code;
}

export const RESERVED = new Set(
  ('break case catch class const continue debugger default delete do else enum export extends false finally for ' +
    'function if import in instanceof new null return super switch this throw true try typeof var void while with ' +
    'yield let static await async implements interface package private protected public arguments eval undefined').split(' '),
);

export function isIdentName(s) {
  return typeof s === 'string' && /^[A-Za-z_$][\w$]*$/.test(s) && !RESERVED.has(s);
}

/** Static name of an object-property / member key, or null. */
export function keyName(node) {
  if (!node) return null;
  const key = node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression' ? node.property : node.key;
  if (!key) return null;
  if (!node.computed && key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  if (key.type === 'NumericLiteral') return String(key.value);
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0) return key.quasis[0].value.cooked;
  return null;
}

/** Dotted name for `a.b.c`, `import.meta.env.X`, `this.x`; null if not a plain chain. */
export function chainName(node) {
  if (!node) return null;
  switch (node.type) {
    case 'Identifier':
      return node.name;
    case 'ThisExpression':
      return 'this';
    case 'MetaProperty':
      return `${node.meta.name}.${node.property.name}`;
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      const obj = chainName(node.object);
      const k = keyName(node);
      return obj && k != null ? `${obj}.${k}` : null;
    }
    default:
      return null;
  }
}

export function locOf(node) {
  return node?.loc ? { line: node.loc.start.line, column: node.loc.start.column } : null;
}
