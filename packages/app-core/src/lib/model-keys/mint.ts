/**
 * A person hands an app or an agent a model key (ADR 0189 §3, §6).
 *
 * This is the one ceremony that creates authority. It runs the vault's own
 * `manage_grants` check, so the duress ceilings and the operator rule apply
 * unchanged; builds the draft from what the person chose and nothing else;
 * digests it; and asks the prover whether a person approved that digest. The
 * broker accepts no root without the proof, so a caller that skips a step here
 * has no way to skip the step after it.
 *
 * The approval is not made here. The sheet reports what the person did, a
 * `MintConfirmation`: the digest of the draft as the sheet showed it and the
 * moment they pressed Create. The custodian's approval is that press, bound to
 * that digest and good for a moment; it is not a passkey, and a script in the
 * page that holds the open vault can write a confirmation too.
 */
import { type Named, name } from "@gdp-ts/core";
import { randomString, sha256Base64Url } from "@opensesame/sdk-browser";
import { proveModelGrantApproved } from "../proofs/model-grant-approval.js";
import {
  type ManageGrants,
  requireManageGrants,
} from "../proofs/share-write.js";
import { activeModelKeyBroker, notifyModelKeys } from "./active.js";
import type { IssuedRoot } from "./broker.js";
import { refuse } from "./errors.js";
import { type ModelGrantDraft, modelGrantDigest } from "./root.js";
import type { ModelAction } from "./vocabulary.js";

/** What the person chose on the sheet. */
export type MintChoice = Readonly<{
  /** The app or agent the key is for. */
  clientId: string;
  connectionId: string;
  /** The provider's base URL, as the catalog writes it. */
  resource: string;
  actions: readonly ModelAction[];
  /** Model ids, `*`, or `namespace/*`. */
  models: readonly string[];
  budget: ModelGrantDraft["budget"];
  lifetimeSeconds: number;
}>;

/**
 * What the person did on the sheet (ADR 0189 §3): the digest of the draft as
 * the sheet displayed it, when they pressed Create, and which press it was. A
 * press makes one key: the same confirmation presented twice is refused.
 */
export type MintConfirmation = Readonly<{
  digest: string;
  pressedAt: number;
  id: string;
}>;

/** A press older than this is not a press the person is still making. */
export const PRESS_WINDOW_MS = 30_000;

/** Presses that have made a key. Older than the window they are refused as stale anyway, so they are forgotten. */
const spentPresses = new Map<string, number>();
const SPENT_PRESS_LIMIT = 256;

/** Spend a press once; false when it has already made a key. Checked and set with no await between. */
function spendPress(confirmation: MintConfirmation, now: number): boolean {
  for (const [id, at] of spentPresses)
    if (now - at > PRESS_WINDOW_MS) spentPresses.delete(id);
  if (spentPresses.has(confirmation.id)) return false;
  spentPresses.set(confirmation.id, confirmation.pressedAt);
  for (const id of spentPresses.keys()) {
    if (spentPresses.size <= SPENT_PRESS_LIMIT) break;
    spentPresses.delete(id);
  }
  return true;
}

const NOT_ID = /[^A-Za-z0-9._:@-]/g;

/** The principal a vault's operator acts as when no hosted identity is involved. */
export function custodianPrincipal(tomb: string): string {
  return `custodian:${tomb.replace(NOT_ID, "_")}`.slice(0, 128);
}

function organizationOf(tomb: string): string {
  return `local:${tomb.replace(NOT_ID, "_")}`.slice(0, 128);
}

function draftOf(tomb: string, choice: MintChoice): ModelGrantDraft {
  return {
    issuerPrincipalId: custodianPrincipal(tomb),
    organizationId: organizationOf(tomb),
    clientId: choice.clientId,
    connectionId: choice.connectionId,
    resource: choice.resource,
    actions: choice.actions,
    models: choice.models,
    budget: choice.budget,
    lifetimeSeconds: choice.lifetimeSeconds,
    maximumDelegationDepth: 2,
    // A page cannot attach a key to a request it did not make; the policy says so.
    dpopJkt: null,
  };
}

/** The confirmation for the draft `choice` makes in `tomb`: what the sheet reports at a press. */
export async function confirmMint(
  tomb: string,
  choice: MintChoice,
  pressedAt: number = Date.now(),
): Promise<MintConfirmation> {
  const digest = await modelGrantDigest(draftOf(tomb, choice), sha256Base64Url);
  return { digest, pressedAt, id: randomString(16) };
}

async function issueAs<V, D>(
  tomb: string,
  named: Named<D, ModelGrantDraft>,
  _authority: ManageGrants<V>,
  confirmation: MintConfirmation,
  now: number,
): Promise<IssuedRoot> {
  const broker = activeModelKeyBroker();
  if (!broker) return refuse("access_denied", "broker.unavailable");
  if (now - confirmation.pressedAt > PRESS_WINDOW_MS)
    return refuse("access_denied", "approval.stale");
  // The vault was open and the person at the sheet when they pressed, so the
  // sign-in and the approval are the same moment.
  const verdict = await proveModelGrantApproved(
    named,
    {
      approverPrincipalId: custodianPrincipal(tomb),
      method: "custodian",
      authenticatedAt: confirmation.pressedAt,
      approvedAt: confirmation.pressedAt,
      boundDigest: confirmation.digest,
    },
    now,
    sha256Base64Url,
  );
  if (!verdict.ok) return refuse("access_denied", `approval.${verdict.code}`);
  if (!spendPress(confirmation, now))
    return refuse("access_denied", "approval.spent");
  const issued = await broker.issueRoot(named, verdict.proof);
  notifyModelKeys();
  return issued;
}

/**
 * Issue a root key for `choice` in the open vault `tomb`, on the person's
 * `confirmation` of it. Rejects with the vault's own refusal when the person
 * may not manage grants, and with a `ModelKeyRefusal` when the catalog, the
 * connection or the policy cannot support what they asked for, when the
 * confirmation was for a different draft (`approval.digest_mismatch`) or when
 * the press is older than `PRESS_WINDOW_MS` (`approval.stale`). Nothing is
 * issued on a refusal.
 */
export function mintModelKey(
  tomb: string,
  choice: MintChoice,
  confirmation: MintConfirmation,
  now: () => number = Date.now,
): Promise<IssuedRoot> {
  return name(tomb, async (vault) => {
    const authority = await requireManageGrants(vault);
    const when = now();
    return name(draftOf(tomb, choice), (draft) =>
      issueAs(vault.value, draft, authority, confirmation, when),
    );
  });
}
