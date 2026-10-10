/**
 * Who may write a standing share (ADR 0178): `ManageGrants<T>` or
 * `SystemShareWrite<T>`, each a proof about the tomb `T` the write lands in.
 *
 * `local-share-grants` used to take `{ bypassAccessCheck: true }`, so "this
 * caller is system code" was a boolean any caller could pass. The write
 * functions now take a `ShareWriteAuthority<T>` for the tomb they write, and
 * there are two ways to hold one, both minted only here:
 *
 * - `requireManageGrants` runs the real `manage_grants` check
 *   (`assertAccessCapability`, so its refusals and its fence ceiling are
 *   unchanged) and answers with the proof only if it passed;
 * - `systemShareWrite` is the explicit, greppable statement that the caller is
 *   a system module acting for the vault itself — a session expiring, a
 *   session code redeemed by someone who holds no grant authority, the
 *   standing dogfood share being renewed. It checks nothing, by design, and
 *   every call to it is a decision a reviewer can find.
 *
 * Neither proof carries the person: authority here is about a tomb.
 */

import { type Named, type Proof, defineProof } from "@gdp-ts/core";
import type { QuorumApproved } from "./quorum-approved.js";

const ManageGrantsProver = defineProof("ManageGrants");
const SystemShareWriteProver = defineProof("SystemShareWrite");

/** The caller passed `manage_grants` in the tomb named `T`. */
export interface ManageGrants<T> extends Proof<"ManageGrants", [T]> {}

/** The caller is system code writing shares for the tomb named `T`. */
export interface SystemShareWrite<T> extends Proof<"SystemShareWrite", [T]> {}

/**
 * What a share write needs to hold, for the tomb it writes. `QuorumApproved`
 * is minted in `quorum-approved.ts`: a circle of the owner's trusted contacts
 * approved this exact grant while the owner was away (ADR 0186).
 */
export type ShareWriteAuthority<T> =
  | ManageGrants<T>
  | SystemShareWrite<T>
  | QuorumApproved<T>;

/**
 * Run the `manage_grants` check and return its proof. Throws exactly what
 * `assertAccessCapability` throws; there is no refusal value to forget.
 */
export async function requireManageGrants<T>(
  tomb: Named<T, string>,
): Promise<ManageGrants<T>> {
  // Lazy for the same reason `local-share-grants` always imported it lazily:
  // `local-rbac` reaches the directory and the session code.
  const { assertAccessCapability } = await import("../local-rbac.js");
  await assertAccessCapability(tomb.value, "manage_grants");
  return ManageGrantsProver.prove(tomb);
}

/** System code writing shares for this vault; see the module note. */
export function systemShareWrite<T>(
  tomb: Named<T, string>,
): SystemShareWrite<T> {
  return SystemShareWriteProver.prove(tomb);
}
