export default function ({ Plugin, types: t }) {
  function toStatements(node) {
    if (t.isBlockStatement(node)) {
      var hasBlockScoped = false;

      for (var i = 0; i < node.body.length; i++) {
        var bodyNode = node.body[i];
        if (t.isBlockScoped(bodyNode)) hasBlockScoped = true;
      }

      if (!hasBlockScoped) {
        return node.body;
      }
    }

    return node;
  }

  var visitor = {
    ReferencedIdentifier(node, parent, scope) {
      var binding = scope.getBinding(node.name);
      if (!binding || binding.references > 1 || !binding.constant) return;
      if (binding.kind === "param" || binding.kind === "module") return;

      // Do not remove exports like `export function t() { }`.
      if (t.isExportDeclaration(binding.path.parent)) return;

      var replacement = binding.path.node;
      if (t.isVariableDeclarator(replacement)) {
        replacement = replacement.init;
      }
      if (!replacement) return;

      // ensure it's a "pure" type
      if (!scope.isPure(replacement, true)) return;

      if (t.isClass(replacement) || t.isFunction(replacement)) {
        // don't change this if it's in a different scope, this can be bad
        // for performance since it may be inside a loop or deeply nested in
        // hot code
        if (binding.path.scope.parent !== scope) return;
      }

      if (this.findParent((path) => path.node === replacement)) {
        return;
      }

      t.toExpression(replacement);
      scope.removeBinding(node.name);
      binding.path.dangerouslyRemove();
      return replacement;
    },

    "ClassDeclaration|FunctionDeclaration"(node, parent, scope) {
      if (t.isClass(node) && node.decorators && node.decorators.length) {
        // We don't want to remove classes that have attached decorators.
        // The decorator itself is referencing the class and might have side effects, like
        // registering the class somewhere else.
        return;
      }
      var binding = scope.getBinding(node.id.name);
      if (binding && !binding.referenced) {
        this.dangerouslyRemove();
      }
    },

    VariableDeclarator(node, parent, scope) {
      if (!t.isIdentifier(node.id) || !scope.isPure(node.init, true)) return;
      visitor["ClassDeclaration|FunctionDeclaration"].apply(this, arguments);
    },

    ConditionalExpression(node) {
      var evaluateTest = this.get("test").evaluateTruthy();
      if (evaluateTest === true) {
        return node.consequent;
      } else if (evaluateTest === false) {
        return node.alternate;
      }
    },

    BlockStatement() {
      var paths = this.get("body");

      var purge = false;

      for (var i = 0; i < paths.length; i++) {
        let path = paths[i];

        if (!purge && path.isCompletionStatement()) {
          purge = true;
          continue;
        }

        if (purge && !path.isFunctionDeclaration()) {
          path.dangerouslyRemove();
        }
      }
    },

    IfStatement: {
      exit(node) {
        var consequent = node.consequent;
        var alternate  = node.alternate;
        var test = node.test;

        var evaluateTest = this.get("test").evaluateTruthy();

        // we can check if a test will be truthy 100% and if so then we can inline
        // the consequent and completely ignore the alternate
        //
        //   if (true) { foo; } -> { foo; }
        //   if ("foo") { foo; } -> { foo; }
        //

        if (evaluateTest === true) {
          return toStatements(consequent);
        }

        // we can check if a test will be falsy 100% and if so we can inline the
        // alternate if there is one and completely remove the consequent
        //
        //   if ("") { bar; } else { foo; } -> { foo; }
        //   if ("") { bar; } ->
        //

        if (evaluateTest === false) {
          if (alternate) {
            return toStatements(alternate);
          } else {
            return this.dangerouslyRemove();
          }
        }

        // remove alternate blocks that are empty
        //
        //   if (foo) { foo; } else {} -> if (foo) { foo; }
        //

        if (t.isBlockStatement(alternate) && !alternate.body.length) {
          alternate = node.alternate = null;
        }

        // if the consequent block is empty turn alternate blocks into a consequent
        // and flip the test
        //
        //   if (foo) {} else { bar; } -> if (!foo) { bar; }
        //

        if (t.isBlockStatement(consequent) && !consequent.body.length && t.isBlockStatement(alternate) && alternate.body.length) {
          node.consequent = node.alternate;
          node.alternate  = null;
          node.test       = t.unaryExpression("!", test, true);
        }
      }
    }
  };

  return new Plugin("dead-code-elimination", {
    metadata: {
      group: "builtin-pre",
      experimental: true
    },

    visitor
  });
}
