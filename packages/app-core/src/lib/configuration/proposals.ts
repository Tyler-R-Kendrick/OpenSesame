const MUTATION = /\b(approve|reveal|grant|enroll|delete|revoke|commit)\b/i;

/**
 * Model and imported comments are untrusted data (ADV-10). A proposal may
 * only become a reviewable draft; it cannot name a mutation tool.
 */
export function refuseUntrustedProposal(text: string):
  | {
      ok: false;
      message: string;
    }
  | { ok: true } {
  if (MUTATION.test(text)) {
    return {
      ok: false,
      message: "Untrusted text cannot approve, reveal, or mutate authority.",
    };
  }
  return { ok: true };
}
