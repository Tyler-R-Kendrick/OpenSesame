import type { Named } from "@gdp-ts/core";
/**
 * The model key broker (ADR 0189): the one object an issuer holds.
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

export class ModelKeyBroker {
  private readonly core: BrokerCore;

  constructor(ports: BrokerPorts, policy: BrokerPolicy = DEFAULT_POLICY) {
    this.core = newCore(ports, policy);
  }

  /**
   * Issue a root key. The proof is the only way in: a person approved this
   * exact draft (`proveModelGrantApproved`), so a caller that holds no approval
   * cannot call this at all.
   */
  async issueRoot<G>(
    draft: Named<G, ModelGrantDraft>,
    approval: ModelGrantApproved<G>,
  ): Promise<IssuedRoot> {
    if (approval.kind !== "ModelGrantApproved")
      return refuse("access_denied", "approval.missing");
    const { core } = this;
    const now = core.ledger.clock(core.ports.now());
    const checked = validateDraft(draft.value, core.ports, core.policy);
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
