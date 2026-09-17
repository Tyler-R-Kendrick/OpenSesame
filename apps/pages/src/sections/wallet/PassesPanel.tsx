/**
 * Wallet › Spending passes — leases backed by allocations (ADR 0123).
 * Presentation passes stay in the vault; this list is authority, not cards.
 */

import { useCallback, useState } from "react";
import { StatusNote } from "../../components/StatusNote.js";
import { signDigestWithEphemeralP256 } from "@opensesame/wallet-consent/verify";
import { buildLocalPaymentApprovalDigest } from "../../lib/spending-consent.js";
import {
  clearSpendingLeases,
  issueSpendingLease,
  listSpendingLeases,
} from "../../lib/spending-leases.js";
import {
  formatUnits,
  getSpendingLedger,
  openDemoHouseholdBudget,
} from "../../lib/spending-ledger.js";
import { safeMerchantLabel } from "../../lib/wallet-safe-label.js";

export function PassesPanel() {
  const [tick, setTick] = useState(0);
  const [message, setMessage] = useState<{
    tone: "ok" | "err" | "warn";
    text: string;
  } | null>(null);

  const refresh = useCallback(() => {
    setTick((n) => n + 1);
  }, []);
  void tick;

  const attempts = [...getSpendingLedger().snapshot().attempts.values()];
  const leases = listSpendingLeases();

  const onIssueDemo = () => {
    setMessage(null);
    openDemoHouseholdBudget();
    const now = new Date();
    const until = new Date(now.getTime() + 60 * 60 * 1000);
    const intent = {
      currency: "TEST",
      amount: "25",
      recipient: "workload-research",
    };
    void (async () => {
      const digest = await buildLocalPaymentApprovalDigest(intent);
      const forged = await issueSpendingLease({
        allocationRef: "child-a",
        beneficiaryRef: "workload-research",
        grantRef: "grant-demo",
        rootAccountingRef: "household",
        intent,
        proof: {
          boundDigest: digest,
          mechanism: "webauthn",
          assurance: "phishing_resistant",
        },
        validFrom: now.toISOString(),
        validUntil: until.toISOString(),
      });
      if (forged.ok) {
        setMessage({
          tone: "err",
          text: "Forged assurance unexpectedly issued a lease.",
        });
        refresh();
        return;
      }

      const pastUntil = new Date(now.getTime() - 60_000).toISOString();
      const pastFrom = new Date(now.getTime() - 120_000).toISOString();
      const expiredWindow = await issueSpendingLease({
        allocationRef: "child-a",
        beneficiaryRef: "workload-research",
        grantRef: "grant-demo",
        rootAccountingRef: "household",
        intent: { ...intent, amount: "5" },
        proof: {
          boundDigest: await buildLocalPaymentApprovalDigest({
            ...intent,
            amount: "5",
          }),
          ...(await signDigestWithEphemeralP256(
            await buildLocalPaymentApprovalDigest({ ...intent, amount: "5" }),
          )),
        },
        validFrom: pastFrom,
        validUntil: pastUntil,
      });
      if (expiredWindow.ok || expiredWindow.reason !== "lease_window_invalid") {
        setMessage({
          tone: "err",
          text: `Expired lease window unexpectedly accepted (${expiredWindow.ok ? "ok" : expiredWindow.reason}).`,
        });
        refresh();
        return;
      }

      const issuedProof = {
        boundDigest: digest,
        ...(await signDigestWithEphemeralP256(digest)),
      };
      const issued = await issueSpendingLease({
        allocationRef: "child-a",
        beneficiaryRef: "workload-research",
        grantRef: "grant-demo",
        rootAccountingRef: "household",
        intent,
        proof: issuedProof,
        validFrom: now.toISOString(),
        validUntil: until.toISOString(),
      });
      if (!issued.ok) {
        setMessage({
          tone: "err",
          text: `Lease refused: ${issued.reason}`,
        });
        refresh();
        return;
      }

      const replay = await issueSpendingLease({
        allocationRef: "child-a",
        beneficiaryRef: "workload-research",
        grantRef: "grant-demo",
        rootAccountingRef: "household",
        intent,
        proof: issuedProof,
        validFrom: now.toISOString(),
        validUntil: until.toISOString(),
      });
      if (replay.ok || replay.reason !== "assertion_replay") {
        setMessage({
          tone: "err",
          text: `Assertion replay unexpectedly accepted (${replay.ok ? "ok" : replay.reason}).`,
        });
        refresh();
        return;
      }

      setMessage({
        tone: "ok",
        text: `Issued lease ${issued.lease.id} for 25 TEST under household. Refused forged WebAuthn/RP label, expired lease window (lease_window_invalid), and assertion replay (assertion_replay). Demo uses an ephemeral local P-256 signature, not a WebAuthn/RP proof.`,
      });
      refresh();
    })();
  };

  const onClear = () => {
    clearSpendingLeases();
    setMessage({
      tone: "warn",
      text: "Cleared local spending leases. External authority is unaffected.",
    });
    refresh();
  };

  return (
    <section className="panel" aria-labelledby="wallet-passes">
      <div className="panel__head">
        <div>
          <h2 id="wallet-passes">Spending passes</h2>
          <p className="hint">
            Leases and reserved payment attempts under a conserved allocation. A
            pass is not a card number and does not settle by itself.
          </p>
        </div>
        <div className="row gap">
          <button type="button" className="btn" onClick={onIssueDemo}>
            Issue demo lease
          </button>
          <button type="button" className="btn" onClick={onClear}>
            Clear leases
          </button>
          <button type="button" className="btn" onClick={refresh}>
            Refresh
          </button>
        </div>
      </div>
      <div className="panel__body">
        {leases.length === 0 && attempts.length === 0 ? (
          <div className="empty">
            <h3>No spending passes</h3>
            <p className="hint">
              Issue a digest-bound lease after Budgets has a household
              allocation, or reserve authority from Budgets › Try sibling
              overspend. Presentation passes stay in the vault.
            </p>
          </div>
        ) : (
          <>
            {leases.length > 0 ? (
              <ul className="list">
                {leases.map((lease) => (
                  <li key={lease.id} className="list__row">
                    <div>
                      <strong>{lease.id}</strong>
                      <span className="chip">{lease.status}</span>
                      <p className="hint">
                        {lease.amount} {lease.currency} →{" "}
                        {safeMerchantLabel(lease.recipient)} · allocation{" "}
                        {lease.allocationRef} · root {lease.rootAccountingRef}
                      </p>
                      <p className="hint">
                        digest {lease.approvalDigest.slice(0, 16)}… · local
                        approval only
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            {attempts.length > 0 ? (
              <ul className="list">
                {attempts.map((attempt) => (
                  <li key={attempt.attemptId} className="list__row">
                    <div>
                      <strong>{attempt.attemptId}</strong>
                      <span className="chip">{attempt.state}</span>
                      <p className="hint">
                        {formatUnits(attempt.amount)} on {attempt.nodeId} · path{" "}
                        {attempt.path.join(" → ")}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
        {message ? <StatusNote message={message} /> : null}
      </div>
    </section>
  );
}
