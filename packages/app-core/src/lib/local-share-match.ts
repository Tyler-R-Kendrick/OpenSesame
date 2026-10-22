/** Whether two shares name the same standing grant (not merely one renewal). */
export type ShareIdentity = {
  principalId: string;
  resourceKind: string;
  resourceId: string;
  policy: string;
  sessionId?: string;
};

export function sameShare(left: ShareIdentity, right: ShareIdentity): boolean {
  return (
    left.principalId === right.principalId &&
    left.resourceKind === right.resourceKind &&
    left.resourceId === right.resourceId &&
    left.policy === right.policy &&
    (left.sessionId ?? "") === (right.sessionId ?? "")
  );
}
