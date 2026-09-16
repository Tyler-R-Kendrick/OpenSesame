/**
 * The agent-surface fence for cross-device interactions (ADR 0086, finding
 * S12 / T-34).
 *
 * The wallet-native interaction layer exists to put a question in front of a
 * *person* and take an answer bound to a cryptographic proof. The server mints
 * the canonical interaction (its id, its opaque reference, its subject row) —
 * see `@opensesame/os-domain`'s `crypto/interaction-ref.ts`, which is Node-only
 * and unreachable from any browser bundle — and a proof is produced by an
 * authenticated human authenticator, never by a headless caller.
 *
 * So no agent surface (MCP host, MCP client, WebMCP) may expose a tool that
 * *settles* an interaction or *mints an approval proof*. The registry already
 * leaves `identity.interaction.{create,approve,deny}` unmapped on every agent
 * surface; this name fence is the belt-and-suspenders regression lock, applied
 * to every implemented catalog exactly as `assertsNoSecretNames` is.
 *
 * Deny-first, and deliberately blind to the humane openers: a tool named
 * `opensesame_open_*` opens a human ceremony UI in the person's own tab and
 * settles nothing, so the pattern keys on the *interaction* and *proof*
 * vocabulary rather than on the verb "open".
 */
export const INTERACTION_SETTLEMENT_PATTERN =
  /interaction|approval_proof|(^|_)proof(_|$)|(^|_)(approve|deny|settle)_interaction/i;

/**
 * Throw if any tool name would settle a canonical interaction or mint an
 * approval proof. Agent surfaces run this over their implemented catalog.
 */
export function assertsNoInteractionSettlementTool(
  names: readonly string[],
): void {
  if (names.some((name) => INTERACTION_SETTLEMENT_PATTERN.test(name))) {
    throw new Error("interaction_settlement_tools_forbidden");
  }
}
