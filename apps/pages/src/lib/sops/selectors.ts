/**
 * Field selection as upstream's `Tree.shouldBeEncrypted` decides it
 * (sops.go, 26e2f478), over the bounded Go/RE2-compatible matcher in
 * `re2.ts` (B09).
 */

import { SopsError } from "./errors.js";
import { MAX_REGEX_INPUT, MAX_REGEX_PATTERN } from "./limits.js";
import { type CompiledRe2, compile, matches } from "./re2.js";

export type SopsPolicy = {
  unencryptedSuffix: string;
  encryptedSuffix: string;
  unencryptedRegex: string;
  encryptedRegex: string;
  unencryptedCommentRegex: string;
  encryptedCommentRegex: string;
  macOnlyEncrypted: boolean;
};

export const DEFAULT_UNENCRYPTED_SUFFIX = "_unencrypted";

export const DEFAULT_POLICY: SopsPolicy = {
  unencryptedSuffix: DEFAULT_UNENCRYPTED_SUFFIX,
  encryptedSuffix: "",
  unencryptedRegex: "",
  encryptedRegex: "",
  unencryptedCommentRegex: "",
  encryptedCommentRegex: "",
  macOnlyEncrypted: false,
};

const cache = new Map<string, CompiledRe2>();

/** Compile a selector pattern or refuse it. Cached per pattern. */
export function compileRe2(pattern: string): CompiledRe2 {
  const cached = cache.get(pattern);
  if (cached) return cached;
  if (pattern.length > MAX_REGEX_PATTERN) {
    throw new SopsError(
      "resource_limit",
      "A regex exceeds the pattern budget.",
    );
  }
  const compiled = compile(pattern);
  cache.set(pattern, compiled);
  return compiled;
}

export function matchRe2(pattern: string, text: string): boolean {
  if (text.length > MAX_REGEX_INPUT) {
    throw new SopsError("resource_limit", "A regex input exceeds the budget.");
  }
  return matches(compileRe2(pattern), text);
}

/** Refuse a policy upstream would refuse: at most one selector rule. */
export function assertPolicyValid(policy: SopsPolicy): void {
  const rules = [
    policy.unencryptedSuffix,
    policy.encryptedSuffix,
    policy.unencryptedRegex,
    policy.encryptedRegex,
    policy.unencryptedCommentRegex,
    policy.encryptedCommentRegex,
  ].filter((rule) => rule !== "").length;
  if (rules > 1) {
    throw new SopsError(
      "invalid_metadata",
      "Only one of the suffix, regex, or comment-regex selectors may be set.",
    );
  }
  for (const pattern of [
    policy.unencryptedRegex,
    policy.encryptedRegex,
    policy.unencryptedCommentRegex,
    policy.encryptedCommentRegex,
  ]) {
    if (pattern !== "") compileRe2(pattern);
  }
}

function anySegment(pattern: string, path: readonly string[]): boolean {
  for (const segment of path) {
    if (matchRe2(pattern, segment)) return true;
  }
  return false;
}

function anySuffix(suffix: string, path: readonly string[]): boolean {
  for (const segment of path) {
    if (segment.endsWith(suffix)) return true;
  }
  return false;
}

/** `unencrypted_comment_regex`: any comment in scope clears the value. */
function clearedByComment(
  pattern: string,
  stack: readonly (readonly string[])[],
): boolean {
  for (const level of stack) {
    for (const comment of level) {
      if (matchRe2(pattern, comment)) return true;
    }
  }
  return false;
}

/**
 * `encrypted_comment_regex`: any comment in scope selects the value, except
 * that the marker comment itself stays in the clear.
 */
function selectedByComment(
  pattern: string,
  stack: readonly (readonly string[])[],
  isComment: boolean,
): boolean {
  const lastLevel = stack.length - 1;
  const lastIndex = (stack[lastLevel]?.length ?? 0) - 1;
  for (let i = 0; i < stack.length; i += 1) {
    const level = stack[i] ?? [];
    for (let j = 0; j < level.length; j += 1) {
      if (isComment && i === lastLevel && j === lastIndex) continue;
      const comment = level[j];
      if (comment !== undefined && matchRe2(pattern, comment)) return true;
    }
  }
  return false;
}

/** Upstream `shouldBeEncrypted` over a path and the live comments stack. */
export function shouldBeEncrypted(
  policy: SopsPolicy,
  path: readonly string[],
  commentsStack: readonly (readonly string[])[],
  isComment: boolean,
): boolean {
  let encrypted = true;
  if (
    policy.unencryptedSuffix !== "" &&
    anySuffix(policy.unencryptedSuffix, path)
  )
    encrypted = false;
  if (policy.encryptedSuffix !== "")
    encrypted = anySuffix(policy.encryptedSuffix, path);
  if (
    policy.unencryptedRegex !== "" &&
    anySegment(policy.unencryptedRegex, path)
  )
    encrypted = false;
  if (policy.encryptedRegex !== "")
    encrypted = anySegment(policy.encryptedRegex, path);
  if (
    policy.unencryptedCommentRegex !== "" &&
    clearedByComment(policy.unencryptedCommentRegex, commentsStack)
  ) {
    encrypted = false;
  }
  if (policy.encryptedCommentRegex !== "") {
    encrypted = selectedByComment(
      policy.encryptedCommentRegex,
      commentsStack,
      isComment,
    );
  }
  return encrypted;
}
