/**
 * The ledger of one request: who has approved, who has released a share, and
 * what may happen next. It is where "approvals must refer to the same request
 * and the request must still be usable" is enforced.
 *
 * Rules, each with a refusal code a test pins:
 * - an approval counts once per guardian, however many keys that guardian has
 *   (`duplicate_guardian`);
 * - an assertion is spent when accepted (`replay`), and a credential's counter
 *   may not go backwards (`counter`);
 * - approvals arrive inside the approval window, releases after the release
 *   delay and before the request lapses (`window`, `too_early`, `expired`);
 * - a share is released only after approvals satisfy the policy, only by a
 *   guardian who approved, and only for `recover-collection` (`quorum`,
 *   `not_approved`, `no_release`);
 * - the owner's signed cancellation ends it (`cancelled`).
 *
 * The ledger holds no key material. A quorum of approvals is not a key: the
 * shares travel separately, sealed to the recipient.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { fromB64url } from "./bytes.js";
import { cancellationBytes } from "./cancellation.js";
import type {
  LedgerSnapshot,
  LedgerStatus,
  LedgerVerdict,
  Outcome,
} from "./ledger-types.js";
import {
  credentialOf,
  guardianById,
  satisfies,
  verifySignedPolicy,
} from "./policy.js";
import { checkRequest, phaseChallenge, requestDigest } from "./request.js";
import {
  type Approval,
  ApprovalSchema,
  type Cancellation,
  CancellationSchema,
  type QuorumRequest,
  type Release,
  ReleaseSchema,
  type SignedPolicy,
} from "./types.js";
import { AssertionError, verifyAssertion } from "./webauthn.js";

const accepted: Outcome = { ok: true };
const refuse = (code: string, message: string): Outcome => ({
  ok: false,
  code,
  message,
});

export class QuorumLedger {
  private readonly approvals = new Map<string, Approval>();
  private readonly releases_ = new Map<string, Release>();
  private readonly counters = new Map<string, number>();
  private readonly spent = new Set<string>();
  private cancellation: Cancellation | null = null;
  private executed = false;

  private constructor(
    readonly signedPolicy: SignedPolicy,
    readonly request: QuorumRequest,
    readonly digest: string,
    private readonly clock: () => number,
  ) {}

  /** Opens a ledger for a request, after checking it against its policy. */
  static open(
    signedPolicy: SignedPolicy,
    request: BoundaryValue,
    clock: () => number = Date.now,
  ): QuorumLedger {
    // A ledger is built over a policy the owner signed, whoever hands it over.
    const verified = verifySignedPolicy(signedPolicy);
    const checked = checkRequest(request, verified);
    return new QuorumLedger(verified, checked, requestDigest(checked), clock);
  }

  /**
   * A ledger for checking a set of approvals after the fact, as a guardian's
   * device does before it releases a share. A signature carries no time, so
   * the approvals are replayed as of the instant the request was raised: the
   * window was kept by the device that signed, not by this check.
   */
  static verifying(
    signedPolicy: SignedPolicy,
    request: BoundaryValue,
  ): QuorumLedger {
    const verified = verifySignedPolicy(signedPolicy);
    const checked = checkRequest(request, verified);
    const raised = new Date(checked.createdAt).getTime();
    return new QuorumLedger(
      verified,
      checked,
      requestDigest(checked),
      () => raised,
    );
  }

  private get policy() {
    return this.signedPolicy.policy;
  }

  private time(iso: string): number {
    return new Date(iso).getTime();
  }

  private gate(code: "approve" | "release"): Outcome {
    const now = this.clock();
    if (this.cancellation)
      return refuse("cancelled", "the owner cancelled this request");
    if (now > this.time(this.request.expiresAt))
      return refuse("expired", "the request has lapsed");
    if (now < this.time(this.request.createdAt))
      return refuse("window", "the request is not open yet");
    if (code === "approve" && now > this.time(this.request.approveBy)) {
      return refuse("window", "the approval window has closed");
    }
    if (code === "release" && now < this.time(this.request.releaseNotBefore)) {
      return refuse(
        "too_early",
        "shares cannot be released until the delay has passed",
      );
    }
    return accepted;
  }

  private async check(
    phase: "approve" | "release",
    submission: Approval | Release,
  ): Promise<Outcome> {
    if (submission.requestDigest !== this.digest) {
      return refuse("digest", "this is for a different request");
    }
    const guardian = guardianById(this.policy, submission.guardianId);
    const credential =
      guardian && credentialOf(guardian, submission.credentialId);
    if (!guardian || !credential) {
      return refuse(
        "unknown_credential",
        "no such guardian credential in this circle",
      );
    }
    try {
      const verified = await verifyAssertion(credential, submission.assertion, {
        challenge: phaseChallenge(phase, this.digest),
        rpId: this.policy.rpId,
        origins: this.policy.origins,
        requireUserVerification: this.policy.requireUserVerification,
        lastCounter: this.counters.get(credential.credentialId) ?? 0,
      });
      if (this.spent.has(verified.signatureDigest)) {
        return refuse("replay", "this assertion was already used");
      }
      this.spent.add(verified.signatureDigest);
      this.counters.set(credential.credentialId, verified.counter);
      return accepted;
    } catch (error) {
      if (error instanceof AssertionError)
        return refuse(error.code, error.message);
      throw error;
    }
  }

  async submitApproval(input: BoundaryValue): Promise<Outcome> {
    const gate = this.gate("approve");
    if (!gate.ok) return gate;
    const parsed = ApprovalSchema.safeParse(input);
    if (!parsed.success) return refuse("malformed", "not an approval");
    const approval = parsed.data;
    if (this.approvals.has(approval.guardianId)) {
      return refuse("duplicate_guardian", "this guardian already approved");
    }
    const checked = await this.check("approve", approval);
    if (!checked.ok) return checked;
    // Verification awaited, so another submission may have landed meanwhile.
    if (this.approvals.has(approval.guardianId)) {
      return refuse("duplicate_guardian", "this guardian already approved");
    }
    this.approvals.set(approval.guardianId, approval);
    return accepted;
  }

  async submitRelease(input: BoundaryValue): Promise<Outcome> {
    if (this.request.operation !== "recover-collection") {
      return refuse("no_release", "this operation releases no share");
    }
    const gate = this.gate("release");
    if (!gate.ok) return gate;
    const parsed = ReleaseSchema.safeParse(input);
    if (!parsed.success) return refuse("malformed", "not a release");
    const release = parsed.data;
    if (!this.quorumMet())
      return refuse("quorum", "approvals do not yet satisfy the policy");
    if (!this.approvals.has(release.guardianId)) {
      return refuse("not_approved", "this guardian did not approve");
    }
    if (this.releases_.has(release.guardianId)) {
      return refuse("duplicate_guardian", "this guardian already released");
    }
    const checked = await this.check("release", release);
    if (!checked.ok) return checked;
    if (this.releases_.has(release.guardianId)) {
      return refuse("duplicate_guardian", "this guardian already released");
    }
    this.releases_.set(release.guardianId, release);
    return accepted;
  }

  /** The owner's cancellation, signed by the key the policy names. */
  cancel(input: BoundaryValue): Outcome {
    const parsed = CancellationSchema.safeParse(input);
    if (!parsed.success) return refuse("malformed", "not a cancellation");
    const c = parsed.data;
    if (
      c.circleId !== this.policy.circleId ||
      c.requestDigest !== this.digest
    ) {
      return refuse("digest", "this cancels a different request");
    }
    const ok = ed25519.verify(
      fromB64url(c.signature),
      cancellationBytes(c),
      fromB64url(this.policy.ownerKey),
    );
    if (!ok)
      return refuse("bad_signature", "the owner signature does not verify");
    this.cancellation = c;
    return accepted;
  }

  approvedGuardians(): string[] {
    return [...this.approvals.keys()];
  }

  /** The approvals accepted so far, as a guardian's device is shown them. */
  approvalList(): Approval[] {
    return [...this.approvals.values()];
  }

  /**
   * Forget a release that did not open or did not match the owner's
   * commitment, so the guardian can release again (and the next
   * combinable set can be chosen). Their approval stands.
   */
  discardRelease(guardianId: string): void {
    this.releases_.delete(guardianId);
  }

  quorumMet(): boolean {
    return satisfies(this.policy, new Set(this.approvals.keys()));
  }

  releases(): Release[] {
    return [...this.releases_.values()];
  }

  /**
   * The releases to combine: exactly the group threshold of groups, each with
   * exactly its member threshold of shares, as SLIP-0039 requires. `null`
   * until there are enough.
   */
  selectForCombine(): Release[] | null {
    const complete = this.policy.groups
      .map((group) => ({
        group,
        mine: group.guardianIds
          .map((id) => this.releases_.get(id))
          .filter((r): r is Release => r !== undefined),
      }))
      .filter(({ group, mine }) => mine.length >= group.threshold);
    if (complete.length < this.policy.groupThreshold) return null;
    return complete
      .slice(0, this.policy.groupThreshold)
      .flatMap(({ group, mine }) => mine.slice(0, group.threshold));
  }

  /**
   * Take the one execution an authorized request allows. `false` when it was
   * taken already; give it back with `releaseExecution` if the action failed.
   */
  claimExecution(): boolean {
    if (this.executed) return false;
    this.executed = true;
    return true;
  }

  releaseExecution(): void {
    this.executed = false;
  }

  verdict(): LedgerVerdict {
    return {
      state: this.status().state,
      operation: this.request.operation,
      circleId: this.policy.circleId,
      requestDigest: this.digest,
      approvedBy: this.approvedGuardians(),
      validUntil: this.request.expiresAt,
    };
  }

  status(): LedgerStatus {
    if (this.cancellation) return { state: "cancelled" };
    if (this.executed) return { state: "executed" };
    const now = this.clock();
    if (now > this.time(this.request.expiresAt)) return { state: "expired" };
    if (this.selectForCombine()) return { state: "complete" };
    const releases = this.request.operation === "recover-collection";
    if (!this.quorumMet()) {
      return now <= this.time(this.request.approveBy)
        ? {
            state: "collecting",
            approved: this.approvals.size,
            closesAt: this.request.approveBy,
          }
        : { state: "approval_closed" };
    }
    if (now < this.time(this.request.releaseNotBefore)) {
      return { state: "waiting", releasableAt: this.request.releaseNotBefore };
    }
    return releases
      ? { state: "releasable", until: this.request.expiresAt }
      : { state: "authorized", until: this.request.expiresAt };
  }

  snapshot(): LedgerSnapshot {
    return {
      approvals: [...this.approvals.values()],
      releases: [...this.releases_.values()],
      counters: Object.fromEntries(this.counters),
      spent: [...this.spent],
      cancellation: this.cancellation,
      executed: this.executed,
    };
  }

  /** Restores what this ledger accepted before. The records are trusted: they came from `snapshot()`. */
  restore(snapshot: LedgerSnapshot): void {
    for (const a of snapshot.approvals) this.approvals.set(a.guardianId, a);
    for (const r of snapshot.releases) this.releases_.set(r.guardianId, r);
    for (const [id, n] of Object.entries(snapshot.counters))
      this.counters.set(id, n);
    for (const s of snapshot.spent) this.spent.add(s);
    this.cancellation = snapshot.cancellation;
    this.executed = snapshot.executed;
  }
}

export type {
  LedgerSnapshot,
  LedgerStatus,
  LedgerVerdict,
  Outcome,
} from "./ledger-types.js";
export { cancellationBytes, signCancellation } from "./cancellation.js";
