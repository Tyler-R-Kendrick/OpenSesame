import type { Named } from "@gdp-ts/core";
/**
 * The model key broker (ADR 0192): the one object an issuer holds.
 *
 * It issues a root key against a person's approval, exchanges a key for a
 * narrower one (RFC 8693), says whether a call may go out on a key and what it
 * will cost, and revokes. It keeps keys in memory only, so a lock, a reload or
 * a closed tab ends every one of them.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { randomString, sha256Base64Url } from "@opensesame/sdk-browser";
import type { ModelGrantApproved } from "../proofs/model-grant-approval.js";
import {
  type AuthorizedCall,
  type CallOutcome,
  type ModelCall,
  type PresentedKey,
  authorizeCall,
  settleCall,
} from "./authorize.js";
import {
  type BrokerCore,
  type Reservation,
  emit,
  mintKey,
  newCore,
  newId,
} from "./core.js";
import { refuse } from "./errors.js";
import {
  type ExchangeContext,
  type ExchangeResponse,
  exchangeKey,
} from "./exchange.js";
import { type ModelGrantDraft, rootRecord, validateDraft } from "./root.js";
import {
  type BrokerPolicy,
  type BrokerPorts,
  DEFAULT_POLICY,
  type KeyView,
} from "./types.js";
import { KEY_PATTERN } from "./vocabulary.js";

export type IssuedRoot = Readonly<{
  /** Shown once. Only its digest is kept. */
  token: string;
  id: string;
  expiresAt: number;
}>;

export type RevokeTarget =
  | Readonly<{ token: string }>
  | Readonly<{ id: string }>
  | Readonly<{ clientId: string }>;

/** The clock, entropy and hash of the running page. */
export const systemClockPorts = {
  now: () => Date.now(),
  random: (bytes: number) => randomString(bytes),
  sha256: (text: string) => sha256Base64Url(text),
} as const satisfies Pick<BrokerPorts, "now" | "random" | "sha256">;

/**
 * The drafts whose approval has been spent. A `ModelGrantApproved<G>` is the
 * one frozen `{ kind }` object `defineProof` hands out each time, so the proof
 * cannot itself say "used"; what it is about is the named draft `G`, and every
 * approval names its draft afresh, so the name is the approval's identity.
 * Module-wide on purpose: a lock resets a broker, not the approval a person
 * already gave, and a second broker must not honour it again.
 */
const spentApprovals = new WeakSet<object>();

export class ModelKeyBroker {
  private readonly core: BrokerCore;

  constructor(ports: BrokerPorts, policy: BrokerPolicy = DEFAULT_POLICY) {
    this.core = newCore(ports, policy);
  }

  /**
   * Issue a root key. The proof is the only way in: a person approved this
   * exact draft (`proveModelGrantApproved`), so a caller that holds no approval
   * cannot call this at all. One approval issues one key: a second try with
   * the same approval is refused, so a person's "yes" is never a standing offer.
   */
  async issueRoot<G>(
    draft: Named<G, ModelGrantDraft>,
    approval: ModelGrantApproved<G>,
  ): Promise<IssuedRoot> {
    if (approval.kind !== "ModelGrantApproved")
      return refuse("access_denied", "approval.missing");
    if (spentApprovals.has(draft))
      return refuse("access_denied", "approval.spent");
    const { core } = this;
    const now = core.ledger.clock(core.ports.now());
    const checked = validateDraft(draft.value, core.ports, core.policy);
    // Spent before the first await, so two calls racing on one approval cannot both pass the check above.
    spentApprovals.add(draft);
    const minted = await mintKey(core);
    const at = core.ledger.clock(core.ports.now());
    const record = rootRecord(draft.value, checked, {
      id: newId(core),
      digest: minted.digest,
      now: at,
    });
    core.ledger.reclaim(at);
    core.ledger.purge();
    core.ledger.add(record);
    emit(
      core,
      {
        type: "root.issued",
        keyId: record.id,
        clientId: draft.value.clientId,
        providerId: record.provider.providerId,
      },
      now,
    );
    return {
      token: minted.token,
      id: record.id,
      expiresAt: record.grant.constraints.expiresAt.getTime(),
    };
  }

  exchange(
    raw: BoundaryValue,
    context: ExchangeContext,
  ): Promise<ExchangeResponse> {
    return exchangeKey(this.core, raw, context);
  }

  authorize(presented: PresentedKey, call: ModelCall): Promise<AuthorizedCall> {
    return authorizeCall(this.core, presented, call);
  }

  settle(reservation: Reservation, outcome: CallOutcome): void {
    settleCall(this.core, reservation, outcome);
  }

  /** RFC 7009: revoking what is unknown is not an error, and says nothing. */
  async revoke(target: RevokeTarget): Promise<readonly string[]> {
    const { core } = this;
    const now = core.ledger.clock(core.ports.now());
    let ids: string[] = [];
    if ("token" in target) {
      if (!KEY_PATTERN.test(target.token)) return [];
      const record = core.ledger.findByDigest(
        await core.ports.sha256(target.token),
      );
      ids = record ? core.ledger.revoke(record.id, now) : [];
    } else if ("id" in target) {
      ids = core.ledger.revoke(target.id, now);
    } else {
      for (const record of core.ledger.records()) {
        if (
          record.grant.parentGrantId === null &&
          record.grant.clientId === target.clientId
        )
          ids.push(...core.ledger.revoke(record.id, now));
      }
    }
    for (const id of ids) emit(core, { type: "key.revoked", keyId: id }, now);
    return ids;
  }

  /** What the key's owner sees: never a key, only what each may still do. */
  list(): readonly KeyView[] {
    const { core } = this;
    const now = core.ledger.clock(core.ports.now());
    core.ledger.reclaim(now);
    return core.ledger.records().map((record) => core.ledger.view(record, now));
  }

  /** Forget every key and every proof: a lock, a sign-out, a disposed capability. */
  reset(): void {
    this.core.ledger.clear();
    this.core.replay.clear();
    this.core.reservations.clear();
  }
}
