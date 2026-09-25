/**
 * One authorization request, read in full before it is decided (ADR 0084;
 * ADR 0140 plan step 9): who asks, what it would allow, how long it is good
 * for, what it takes and why, and which channel pointed here. All of it is
 * ceremony-kit's words (`approval-copy.ts`); nothing on this panel is
 * written here.
 *
 * The approval is explicit, never one tap: the person says they read it (a
 * checkbox), types the comparison code when the policy asks for one, and
 * only then presses the key that runs the passkey. The review model checks
 * each of those before any call — and so before a passkey prompt — and binds
 * the activation to the digest shown, the verb and the policy shown.
 */

import {
  APPROVAL_LABELS,
  type ApprovalPhase,
  reviewFacts,
} from "@opensesame/app-core/lib/approvals-route.js";
import { type FormEvent, useState } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import {
  IconAlert,
  IconCheck,
  IconPasskey,
  IconX,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import type { ApprovalReviewView } from "./useApprovalReview.js";

type Review = Extract<ApprovalPhase, { kind: "review" }>;

function Facts({ phase }: { phase: Review }) {
  const { request } = phase;
  const facts = reviewFacts(phase);
  return (
    <dl className="kv">
      <div>
        <dt>{APPROVAL_LABELS.requester}</dt>
        <dd>{facts.asker}</dd>
      </div>
      <div>
        <dt>{APPROVAL_LABELS.expires}</dt>
        <dd>
          <time dateTime={request.expiresAt}>
            {new Date(request.expiresAt).toLocaleString()}
          </time>
        </dd>
      </div>
      <div>
        <dt>{APPROVAL_LABELS.request}</dt>
        <dd>
          <code title={request.requestDigest}>
            {request.requestDigest.slice(0, 12)}…
          </code>
        </dd>
      </div>
      <div>
        <dt>{APPROVAL_LABELS.grants}</dt>
        <dd>
          <ul>
            {facts.grants.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </dd>
      </div>
      <div>
        <dt>{APPROVAL_LABELS.requires}</dt>
        <dd>
          <ul>
            {facts.needs.map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
        </dd>
      </div>
    </dl>
  );
}

export function ApproveReview({
  phase,
  view,
  online,
}: {
  phase: Review;
  view: ApprovalReviewView;
  online: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [comparison, setComparison] = useState("");
  const { requirement, request } = phase;
  const { busy, step } = view;
  const off = busy || !online;
  const decision = () => ({
    confirmed,
    ...(requirement.requireComparison ? { comparison } : undefined),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!off) view.approve(decision());
  }
  const approveLabel = requirement.requireTransactionBoundActivation
    ? APPROVAL_LABELS.approveWithPasskey
    : APPROVAL_LABELS.approve;
  return (
    <section className="panel" aria-label={APPROVAL_LABELS.title}>
      <div className="panel__head">
        <h2>{request.bindingMessage}</h2>
      </div>
      <div className="panel__body">
        <Facts phase={phase} />
        <form onSubmit={submit} noValidate>
          {requirement.requireComparison ? (
            <div className="field">
              <label htmlFor="approve-comparison">
                {APPROVAL_LABELS.comparison}
              </label>
              <input
                id="approve-comparison"
                className="mono"
                autoComplete="off"
                inputMode="numeric"
                maxLength={6}
                value={comparison}
                disabled={busy}
                onChange={(event) =>
                  setComparison(event.target.value.replace(/[^0-9]/g, ""))
                }
              />
            </div>
          ) : null}
          <label className="field">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{" "}
            {APPROVAL_LABELS.confirm}
          </label>
          <FormCommit
            label={approveLabel}
            icon={
              requirement.requireTransactionBoundActivation ? (
                <IconPasskey size={18} />
              ) : (
                <IconCheck size={18} />
              )
            }
            disabled={off || !confirmed}
            busy={busy}
          >
            <IconKey
              label={APPROVAL_LABELS.deny}
              danger
              disabled={off}
              onClick={() => view.deny(decision())}
            >
              <IconX size={16} />
            </IconKey>
            <IconKey
              label={APPROVAL_LABELS.report}
              disabled={off}
              onClick={view.report}
            >
              <IconAlert size={16} />
            </IconKey>
            <output aria-live={step.alarm ? "assertive" : "polite"}>
              {step.message ? (
                <StatusMark tone="err" label={step.message} />
              ) : null}
            </output>
          </FormCommit>
        </form>
      </div>
    </section>
  );
}
