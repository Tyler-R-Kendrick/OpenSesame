/**
 * Agent-facing Wallet broker (ADR 0123).
 *
 * Prepared execution refs are issued internally after digest-bound approval.
 * Callers cannot construct a spendable ref. Identity in the payload is ignored;
 * the authenticated session principal is the caller.
 */

import {
  type DigestBoundPaymentProof,
  type LocalPaymentApprovalIntent,
  assessLocalPaymentApproval,
} from "./spending-consent.js";
import {
  listActiveSpendingLeases,
  listSpendingLeases,
  requestStopSpendingLease,
} from "./spending-leases.js";
import { formatUnits, getSpendingLedger } from "./spending-ledger.js";

export type AgentCaller = {
  readonly principalRef: string;
  readonly actorInstanceRef?: string;
  readonly proofKeyThumbprint?: string;
};

export type WalletProposal = {
  readonly proposalId: string;
  readonly status: "proposed";
  readonly nodeId: string;
  readonly amount: string;
  readonly destination: string;
  readonly requiresApproval: true;
  readonly settles: false;
};

type StoredProposal = WalletProposal & { issued: boolean };

type PreparedSpend = {
  ref: string;
  singleUseToken: string;
  proposalId: string;
  nodeId: string;
  amount: bigint;
  consumed: boolean;
};

const proposals = new Map<string, StoredProposal>();
const prepared = new Map<string, PreparedSpend>();

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function resetWalletAgentBroker(): void {
  proposals.clear();
  prepared.clear();
}

export function proposeWalletPayment(input: {
  readonly caller: AgentCaller;
  readonly nodeId: string;
  readonly amount: string;
  readonly destination: string;
  readonly claimedPrincipalRef?: string;
}):
  | { ok: true; proposal: WalletProposal }
  | { ok: false; code: "CALLER_NOT_AUTHORIZED" | "INVALID_AMOUNT" } {
  if (
    input.claimedPrincipalRef !== undefined &&
    input.claimedPrincipalRef !== input.caller.principalRef
  ) {
    return { ok: false, code: "CALLER_NOT_AUTHORIZED" };
  }
  if (!/^[0-9]+$/u.test(input.amount) || input.amount === "0") {
    return { ok: false, code: "INVALID_AMOUNT" };
  }
  const proposal: StoredProposal = {
    proposalId: newId("prop"),
    status: "proposed",
    nodeId: input.nodeId,
    amount: input.amount,
    destination: input.destination,
    requiresApproval: true,
    settles: false,
    issued: false,
  };
  proposals.set(proposal.proposalId, proposal);
  return {
    ok: true,
    proposal: {
      proposalId: proposal.proposalId,
      status: proposal.status,
      nodeId: proposal.nodeId,
      amount: proposal.amount,
      destination: proposal.destination,
      requiresApproval: true,
      settles: false,
    },
  };
}

export type IssuePreparedSpendRefusal =
  | "PROPOSAL_MISSING"
  | "PROPOSAL_ALREADY_ISSUED"
  | "INTENT_BINDING_MISMATCH"
  | "digest_mismatch"
  | "missing_verified_bytes"
  | "unverified_assurance"
  | "signature_invalid";

/** Owner/consent path issues a single-use prepared ref. Not agent-callable. */
export async function issuePreparedSpend(input: {
  readonly proposalId: string;
  readonly intent: LocalPaymentApprovalIntent;
  readonly proof: DigestBoundPaymentProof;
}): Promise<
  | { ok: true; prepared: { ref: string; singleUseToken: string } }
  | { ok: false; code: IssuePreparedSpendRefusal }
> {
  const proposal = proposals.get(input.proposalId);
  if (proposal === undefined) {
    return { ok: false, code: "PROPOSAL_MISSING" };
  }
  if (proposal.issued) {
    return { ok: false, code: "PROPOSAL_ALREADY_ISSUED" };
  }
  if (
    input.intent.amount !== proposal.amount ||
    input.intent.recipient !== proposal.destination ||
    input.intent.allocationRef !== proposal.nodeId
  ) {
    return { ok: false, code: "INTENT_BINDING_MISMATCH" };
  }
  const assessment = await assessLocalPaymentApproval({
    intent: input.intent,
    proof: input.proof,
  });
  if (!assessment.ok) {
    return { ok: false, code: assessment.reason };
  }
  proposal.issued = true;
  const ref = newId("prep");
  const singleUseToken = newId("tok");
  prepared.set(ref, {
    ref,
    singleUseToken,
    proposalId: proposal.proposalId,
    nodeId: proposal.nodeId,
    amount: BigInt(proposal.amount),
    consumed: false,
  });
  return { ok: true, prepared: { ref, singleUseToken } };
}

export function executeApprovedWalletPayment(input: {
  readonly caller: AgentCaller;
  readonly preparedRef: string;
  readonly singleUseToken?: string;
}):
  | { ok: true; attemptId: string; state: "reserved" }
  | {
      ok: false;
      code:
        | "CALLER_NOT_AUTHORIZED"
        | "PREPARED_REF_INVALID"
        | "INSUFFICIENT_AVAILABLE";
    } {
  void input.caller;
  const slot = prepared.get(input.preparedRef);
  if (
    slot === undefined ||
    slot.consumed ||
    slot.singleUseToken !== input.singleUseToken
  ) {
    return { ok: false, code: "PREPARED_REF_INVALID" };
  }
  const attemptId = newId("attempt");
  try {
    getSpendingLedger().reserve({
      attemptId,
      nodeId: slot.nodeId,
      amount: slot.amount,
    });
  } catch {
    return { ok: false, code: "INSUFFICIENT_AVAILABLE" };
  }
  slot.consumed = true;
  return { ok: true, attemptId, state: "reserved" };
}

export function walletPaymentStatus(): {
  readonly status: "local_ledger";
  readonly productionEnabled: false;
  readonly settlesOffline: false;
  readonly attempts: readonly {
    readonly attemptId: string;
    readonly nodeId: string;
    readonly amount: string;
    readonly state: string;
  }[];
} {
  const attempts = [...getSpendingLedger().snapshot().attempts.values()];
  return {
    status: "local_ledger",
    productionEnabled: false,
    settlesOffline: false,
    attempts: attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      nodeId: attempt.nodeId,
      amount: formatUnits(attempt.amount),
      state: attempt.state,
    })),
  };
}

export function walletLeaseStatus(): {
  readonly leases: readonly {
    readonly id: string;
    readonly status: string;
    readonly amount: string;
  }[];
  readonly active: readonly { readonly id: string; readonly amount: string }[];
} {
  return {
    leases: listSpendingLeases().map((lease) => ({
      id: lease.id,
      status: lease.status,
      amount: lease.amount,
    })),
    active: listActiveSpendingLeases().map((lease) => ({
      id: lease.id,
      amount: lease.amount,
    })),
  };
}

export function requestWalletLeaseStop(input: { readonly leaseId: string }):
  | { ok: true; status: "stop_requested" }
  | { ok: false; code: "LEASE_MISSING" } {
  if (!requestStopSpendingLease(input.leaseId)) {
    return { ok: false, code: "LEASE_MISSING" };
  }
  return { ok: true, status: "stop_requested" };
}
