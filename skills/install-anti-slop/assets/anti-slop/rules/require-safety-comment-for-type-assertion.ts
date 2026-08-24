import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

const commentOwnerKinds = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);

function isConstAssertion(node: TypeAssertion): boolean {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

type SafetyCommentState = "missing" | "invalid" | "valid";

const safetyEvidence =
  /\b(?:already|boundary|checked|contract|established|fixture|global|implements|invariant|json|label|matches|owns|parser|preserves|runtime|same|schema|scope|seam|signal|stream|structural(?:ly)?|validated|verified)\b/iu;

function safetyCommentState(
  sourceCode: SourceCode,
  node: TypeAssertion,
): SafetyCommentState {
  let current: ESTree.Node = node;
  while (true) {
    const comments = sourceCode.getCommentsBefore(current).slice().reverse();
    for (const comment of comments) {
      if (comment.end > node.start || !/\bSAFETY\s*:/u.test(comment.value)) continue;
      if (!/^\s*$/u.test(sourceCode.text.slice(comment.end, current.start))) continue;
      const body = comment.value.split(/\bSAFETY\s*:/u, 2)[1]?.trim() ?? "";
      return safetyEvidence.test(body) ? "valid" : "invalid";
    }
    if (commentOwnerKinds.has(current.type) || current.parent.type === "Program") {
      return "missing";
    }
    current = current.parent;
  }
}

/** Require every non-const type assertion to state the invariant TypeScript cannot express. */
export const requireSafetyCommentForTypeAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a nearby SAFETY comment for every TypeScript type assertion except const assertions.",
    },
    messages: {
      invalidSafetyComment:
        "This `SAFETY:` comment does not identify checked evidence or the contract boundary that makes the assertion sound.",
      missingSafetyComment:
        "This type assertion has no `SAFETY:` justification. State the checked invariant immediately before the assertion or its containing statement.",
    },
  },
  createOnce(context) {
    const checkAssertion = (node: TypeAssertion) => {
      if (isConstAssertion(node)) return;
      const state = safetyCommentState(context.sourceCode, node);
      if (state === "valid") return;
      context.report({
        node,
        messageId:
          state === "invalid" ? "invalidSafetyComment" : "missingSafetyComment",
      });
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
