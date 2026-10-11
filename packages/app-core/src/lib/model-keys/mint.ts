/**
 * A person hands an app or an agent a model key (ADR 0189 §3, §6).
 *
 * This is the one ceremony that creates authority. It runs the vault's own
 * `manage_grants` check, so the duress ceilings and the operator rule apply
 * unchanged; builds the draft from what the person chose and nothing else;
 * digests it; and asks the prover whether a person approved that digest. The
 * broker accepts no root without the proof, so a caller that skips a step here
 * has no way to skip the step after it.
 */
import { type Named, name } from "@gdp-ts/core";
import { sha256Base64Url } from "@opensesame/sdk-browser";
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

async function issueAs<V, D>(
  tomb: string,
  named: Named<D, ModelGrantDraft>,
  _authority: ManageGrants<V>,
  now: number,
): Promise<IssuedRoot> {
  const broker = activeModelKeyBroker();
  if (!broker) return refuse("access_denied", "broker.unavailable");
  const digest = await modelGrantDigest(named.value, sha256Base64Url);
  const verdict = await proveModelGrantApproved(
    named,
    {
      approverPrincipalId: custodianPrincipal(tomb),
      method: "custodian",
      authenticatedAt: now,
      approvedAt: now,
      boundDigest: digest,
    },
    now,
    sha256Base64Url,
  );
  if (!verdict.ok) return refuse("access_denied", `approval.${verdict.code}`);
  const issued = await broker.issueRoot(named, verdict.proof);
  notifyModelKeys();
  return issued;
}

/**
 * Issue a root key for `choice` in the open vault `tomb`. Rejects with the
 * vault's own refusal when the person may not manage grants, and with a
 * `ModelKeyRefusal` when the catalog, the connection or the policy cannot
 * support what they asked for.
 */
export function mintModelKey(
  tomb: string,
  choice: MintChoice,
  now: () => number = Date.now,
): Promise<IssuedRoot> {
  return name(tomb, async (vault) => {
    const authority = await requireManageGrants(vault);
    const when = now();
    return name(draftOf(tomb, choice), (draft) =>
      issueAs(vault.value, draft, authority, when),
    );
  });
}
