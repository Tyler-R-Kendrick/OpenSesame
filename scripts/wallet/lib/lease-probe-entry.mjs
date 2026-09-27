/**
 * The browser half of the WAL-B03/B05 lease probe (see `lease-probe.mjs`).
 *
 * Bundled from source and run on the static origin, so it exercises the
 * product's own lease module with the browser's own WebCrypto and storage —
 * the same sequence Wallet › Spending passes' "Issue demo lease" button ran
 * before bcd8d7c3 removed that demo control from the product.
 */

import { browserPorts } from "../../../packages/app-core/src/browser/host.ts";
import {
  composeHost,
  configureHost,
} from "../../../packages/app-core/src/host.ts";
import {
  buildLocalPaymentApprovalDigest,
  enrollPaymentApprovalKey,
  localPaymentApprovalIntent,
} from "../../../packages/app-core/src/lib/spending-consent.ts";
import {
  issueSpendingLease,
  listSpendingLeases,
} from "../../../packages/app-core/src/lib/spending-leases.ts";
import { getSpendingLedger } from "../../../packages/app-core/src/lib/spending-ledger.ts";
import { signDigestWithEphemeralP256 } from "../../../packages/wallet-consent/src/verify.ts";

const reason = (result) => (result.ok ? "issued" : result.reason);

function lease(intent, proof) {
  return issueSpendingLease({
    allocationRef: intent.allocationRef,
    beneficiaryRef: "workload-research",
    grantRef: "grant-probe",
    rootAccountingRef: "household",
    intent,
    proof,
    validFrom: intent.validFrom,
    validUntil: intent.validUntil,
  });
}

/** A signed proof whose key the device has enrolled, as the owner's ceremony does. */
async function enrolledProof(digest) {
  const signed = await signDigestWithEphemeralP256(digest);
  enrollPaymentApprovalKey(signed.publicKeySpki);
  return { boundDigest: digest, ...signed };
}

export async function runLeaseProbe(base) {
  configureHost(
    composeHost(browserPorts(), { env: { BASE_URL: base, DEV: false } }),
  );
  getSpendingLedger().transact((tx) => {
    tx.openNode({
      nodeId: "household",
      ceiling: 1000n,
      strategy: "shared_counter",
    });
    tx.openNode({
      nodeId: "child-a",
      parentId: "household",
      ceiling: 0n,
      strategy: "shared_counter",
    });
  });

  const now = Date.now();
  const at = (offset) => new Date(now + offset).toISOString();
  const intent = localPaymentApprovalIntent({
    amount: "25",
    validFrom: at(0),
    validUntil: at(3_600_000),
  });
  const digest = await buildLocalPaymentApprovalDigest(intent);

  // A client-written WebAuthn label with no assertion bytes behind it.
  const forged = await lease(intent, {
    boundDigest: digest,
    mechanism: "webauthn",
    assurance: "phishing_resistant",
  });
  // A real signature from a key this device never enrolled (the wrong RP).
  const stranger = await lease(intent, {
    boundDigest: digest,
    ...(await signDigestWithEphemeralP256(digest)),
  });

  const expiredIntent = localPaymentApprovalIntent({
    ...intent,
    amount: "5",
    validFrom: at(-120_000),
    validUntil: at(-60_000),
  });
  const expired = await lease(
    expiredIntent,
    await enrolledProof(await buildLocalPaymentApprovalDigest(expiredIntent)),
  );

  const proof = await enrolledProof(digest);
  const issued = await lease(intent, proof);
  const replay = await lease(intent, proof);

  return {
    forged: reason(forged),
    stranger: reason(stranger),
    expired: reason(expired),
    issued: reason(issued),
    replay: reason(replay),
    leases: listSpendingLeases().length,
  };
}
