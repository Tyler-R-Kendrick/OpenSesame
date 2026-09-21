/**
 * Go RE2 subset used by SOPS selectors. Lookaround and backreferences are
 * rejected. Accepted patterns are the overlap where RE2 and this engine agree.
 */

const BANNED = /\(\?[=!<]|\(\?<|\(\?P|\\[1-9]/u;
const NESTED = /(?:\+|\*|\{[0-9,]+\})\s*(?:\+|\*|\{)/u;

export function matchRe2(pattern: string, text: string): boolean {
  if (pattern.length > 256 || text.length > 8192) {
    throw new Error("regex budget");
  }
  if (BANNED.test(pattern) || NESTED.test(pattern)) {
    throw new Error("unsupported regex");
  }
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, "u");
  } catch {
    throw new Error("invalid regex");
  }
  return compiled.test(text);
}
