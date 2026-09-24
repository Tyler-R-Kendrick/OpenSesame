import type { AppContext } from "../context.js";

export async function countLiveClaims(
  ctx: AppContext,
  principalId: string,
  now: Date,
): Promise<number> {
  const sessions = await ctx.claimStore.listSessions(principalId);
  return sessions.filter(
    (session) =>
      session.creatorPrincipalId === principalId &&
      session.expiresAt > now &&
      !["completed", "denied", "revoked", "expired"].includes(session.state),
  ).length;
}
