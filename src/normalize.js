import { traverse, t, isIdentName } from './ast.js';

/**
 * Structure-only cleanups that undo typical minifier tricks. Never renames.
 */
export function normalize(ast) {
  traverse(ast, {
    UnaryExpression(path) {
      const { operator, argument } = path.node;
      if (operator === '!' && t.isNumericLiteral(argument) && (argument.value === 0 || argument.value === 1)) {
        path.replaceWith(t.booleanLiteral(argument.value === 0));
      } else if (operator === 'void' && t.isNumericLiteral(argument, { value: 0 }) && !path.scope.getBinding('undefined')) {
        path.replaceWith(t.identifier('undefined'));
      }
    },

    MemberExpression(path) {
      const { node } = path;
      if (node.computed && t.isStringLiteral(node.property) && isIdentName(node.property.value)) {
        node.computed = false;
        node.property = t.identifier(node.property.value);
      }
    },

    ExpressionStatement: {
      exit(path) {
        const expr = path.node.expression;
        // a, b, c;  ->  a; b; c;
        if (t.isSequenceExpression(expr)) {
          replaceStatement(path, expr.expressions.map((e) => t.expressionStatement(e)));
          return;
        }
        // cond && fn();  ->  if (cond) fn();
        if (t.isLogicalExpression(expr, { operator: '&&' })) {
          replaceStatement(path, [t.ifStatement(expr.left, t.expressionStatement(expr.right))]);
          return;
        }
        if (t.isLogicalExpression(expr, { operator: '||' })) {
          replaceStatement(path, [t.ifStatement(t.unaryExpression('!', expr.left), t.expressionStatement(expr.right))]);
          return;
        }
        // cond ? a() : b();  ->  if (cond) a(); else b();
        if (t.isConditionalExpression(expr)) {
          replaceStatement(path, [
            t.ifStatement(expr.test, t.expressionStatement(expr.consequent), t.expressionStatement(expr.alternate)),
          ]);
        }
      },
    },

    ReturnStatement: {
      exit(path) {
        const arg = path.node.argument;
        // return (a(), b);  ->  a(); return b;
        if (t.isSequenceExpression(arg)) {
          const exprs = arg.expressions;
          const stmts = exprs.slice(0, -1).map((e) => t.expressionStatement(e));
          stmts.push(t.returnStatement(exprs[exprs.length - 1]));
          replaceStatement(path, stmts);
        }
      },
    },

    VariableDeclaration(path) {
      const { node, parentPath } = path;
      if (node.declarations.length < 2) return;
      if (!(parentPath.isBlockStatement() || parentPath.isProgram() || parentPath.isStaticBlock?.())) return;
      replaceStatement(
        path,
        node.declarations.map((d) => t.variableDeclaration(node.kind, [d])),
      );
    },
  });
}

function replaceStatement(path, statements) {
  if (statements.length === 0) return;
  const inList = typeof path.key === 'number';
  if (inList) {
    path.replaceWithMultiple(statements);
  } else if (statements.length === 1) {
    path.replaceWith(statements[0]);
  } else {
    path.replaceWith(t.blockStatement(statements));
  }
}
