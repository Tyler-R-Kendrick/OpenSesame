/**
 * The character-password builder lives in vault-core (`character-rules.ts`) so
 * a derived password can be computed wherever a vault is read. This module is
 * where the generators in this directory have always imported it from.
 */
export {
  type IndexSource,
  MAX_PASSWORD_LENGTH,
  buildCharacters,
  effectiveLength,
  ruleAlphabet,
} from "@opensesame/vault-core";
