export type ApprovalReview = {
  requestId: string;
  reviewerId: string;
  requesterId: string;
  revision: string;
  expiresAt: string;
  actor: "human" | "agent";
  surface: "ceremony" | "webmcp";
};

export function commitApproval(
  review: ApprovalReview,
  current: ApprovalReview,
  now: number = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (review.requestId !== current.requestId) {
    return { ok: false, reason: "request_mismatch" };
  }
  if (review.revision !== current.revision) {
    return { ok: false, reason: "stale_or_widened" };
  }
  if (Date.parse(current.expiresAt) <= now) {
    return { ok: false, reason: "expired" };
  }
  if (review.reviewerId === current.requesterId) {
    return { ok: false, reason: "self_approval" };
  }
  if (review.actor === "agent" || review.surface === "webmcp") {
    return { ok: false, reason: "human_only" };
  }
  return { ok: true };
}
