/**
 * Boat's configuration ceremony in Settings › Integrations › Password
 * reset: claim the person's Boat account (auth.md), seal its identity
 * on this device, then hand them Boat's own checkout for the trial.
 * Nothing is configured by pasting a key — Boat allocates sandboxes
 * only to a claimed, billed account, so the claim is the setup.
 */
import type { Connection } from "@opensesame/app-core/lib/connections.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import type { FormEvent } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconRefresh, IconX } from "../../../components/Icons.js";
import { ConnectorPanel } from "../connect/ConnectorPanel.js";
import "../connect/connect.css";
import { useBoatCeremony } from "./useBoatCeremony.js";

type Ceremony = ReturnType<typeof useBoatCeremony>;

function EmailStage({ state }: { state: Ceremony }) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!state.busy && state.email.includes("@")) state.onStartClaim();
  };
  return (
    <form
      className="cx-form panel__body"
      aria-label="Claim a Boat account"
      onSubmit={submit}
    >
      <p className="hint">
        Boat runs sandboxes only for a claimed account. Enter your email
        and OpenSesame will register with Boat, show you a one-time code,
        and wait while you claim the account on Boat's own page. The
        identity Boat issues is sealed on this device; no API key is
        ever pasted.
      </p>
      <FieldShell
        label="Boat account email"
        type="email"
        autoComplete="email"
        value={state.email}
        onValueChange={state.onEmail}
        disabled={state.busy}
      />
      <FormCommit
        label="Start claim"
        busy={state.busy}
        disabled={!state.email.includes("@")}
        disabledReason="Enter the email for the Boat account first."
      />
    </form>
  );
}

function ClaimingStage({ state }: { state: Ceremony }) {
  if (!state.claim) return null;
  return (
    <div className="cx-form panel__body">
      <p className="hint">
        Open Boat's claim page and enter this code. This panel is waiting
        for Boat to confirm the claim.
      </p>
      <dl className="cx-facts">
        <div className="cx-fact">
          <dt>Claim code</dt>
          <dd>{state.claim.userCode}</dd>
        </div>
        <div className="cx-fact">
          <dt>Claim page</dt>
          <dd>
            <a
              href={state.claim.verificationUri}
              target="_blank"
              rel="noopener noreferrer"
            >
              boat.dev — claim this account
            </a>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function BillingStage({ state }: { state: Ceremony }) {
  return (
    <div className="cx-form panel__body">
      <p className="hint">
        Boat creates sandboxes only once billing is active: the 7-day
        trial needs a card on file at Boat's own checkout. OpenSesame
        never sees the card.
      </p>
      <dl className="cx-facts">
        <div className="cx-fact">
          <dt>Account</dt>
          <dd>{state.account?.login || state.savedLogin || state.savedEmail}</dd>
        </div>
        <div className="cx-fact">
          <dt>Billing</dt>
          <dd>{state.account?.blockedReason ?? "not checked yet"}</dd>
        </div>
      </dl>
      <FormCommit
        label="Open Boat checkout"
        busy={state.busy}
        onClick={state.onOpenCheckout}
      >
        <IconKey
          label="Check billing again"
          disabled={state.busy}
          onClick={state.onCheckBilling}
        >
          <IconRefresh size={16} />
        </IconKey>
      </FormCommit>
    </div>
  );
}

function ReadyStage({ state }: { state: Ceremony }) {
  return (
    <div className="cx-form panel__body">
      <p className="hint">
        Boat reports no billing block. Password resets can run in Boat
        sandboxes from this device.
      </p>
      <dl className="cx-facts">
        <div className="cx-fact">
          <dt>Account</dt>
          <dd>{state.account?.login || state.savedLogin || state.savedEmail}</dd>
        </div>
        <div className="cx-fact">
          <dt>Access tier</dt>
          <dd>{state.account?.accessTier ?? "—"}</dd>
        </div>
      </dl>
      <FormCommit
        label="Check Boat again"
        busy={state.busy}
        onClick={state.onCheckBilling}
      />
    </div>
  );
}

export function BoatPanels({
  connection,
  onFlash,
  onChanged,
}: {
  connection: Connection | null;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
}) {
  const state = useBoatCeremony(connection, onFlash, onChanged);
  return (
    <div className="cx-setup">
      <ConnectorPanel
        step={2}
        label="Boat account"
        title={state.savedId ? "Boat account" : "Claim Boat"}
        focus
        actions={
          state.savedId ? (
            <IconKey
              label="Forget Boat connection"
              disabled={state.busy}
              onClick={state.onForget}
            >
              <IconX size={16} />
            </IconKey>
          ) : state.stage === "claiming" ? (
            <IconKey label="Cancel claim" onClick={state.onCancelClaim}>
              <IconX size={16} />
            </IconKey>
          ) : null
        }
      >
        {state.stage === "email" ? <EmailStage state={state} /> : null}
        {state.stage === "claiming" ? <ClaimingStage state={state} /> : null}
        {state.stage === "billing" || state.stage === "saved" ? (
          <BillingStage state={state} />
        ) : null}
        {state.stage === "ready" ? <ReadyStage state={state} /> : null}
      </ConnectorPanel>
      <FailureNotice
        id="boat-connection"
        title="Boat connection"
        message={state.failure}
      />
    </div>
  );
}
