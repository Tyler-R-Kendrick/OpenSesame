import { useState } from "react";
import { IconAlert, IconCheck, IconCopy } from "../../components/Icons.js";
import { addLocalGrant } from "../../lib/access-book.js";
import { type MintedOffer, mintOffer } from "../../lib/access.js";
import { type Connection, bindConnection } from "../../lib/connections.js";
import { accessErrorText } from "./access-errors.js";
import { countdown, useCopy, useNow } from "./grant-ceremony-hooks.js";
import {
  type Assignment,
  type GrantTarget,
  type MintedCode,
  type ScopeInput,
  assignmentLabel,
  formatDuration,
  targetName,
} from "./grant-ceremony-types.js";
import { recipientLabel } from "./grant-ceremony-types.js";

export function MintStep({
  target,
  connection,
  assignment,
  scope,
  online,
  onBack,
  onMinted,
}: {
  target: GrantTarget;
  connection: Connection | null;
  assignment: Assignment;
  scope: ScopeInput;
  online: boolean;
  onBack: () => void;
  onMinted: (minted: MintedOffer, bindWarning: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mint() {
    setBusy(true);
    setError(null);
    const mintLocal = (bindWarning: string | null = null) => {
      const record = addLocalGrant({
        title: targetName(target),
        claimant:
          assignment.kind === "anyone" ? "anyone" : assignmentLabel(assignment),
        resource: connection?.connectionRef ?? targetName(target),
        actions: scope.actions,
        mode: scope.executionMode,
        expiresInSeconds: scope.expiresInSeconds,
      });
      const minted: MintedOffer = {
        claimToken: record.id,
        userCode: record.id.replace(/-/g, "").slice(-8).toUpperCase(),
        offer: {
          id: record.id,
          state: "pending",
          manifestDigest: record.id,
          expiresAt: record.expiresAt,
          items: [],
        },
      };
      onMinted(minted, bindWarning);
    };
    try {
      if (connection === null || connection.connectionId === "conn_local") {
        mintLocal();
        return;
      }
      const minted = await mintOffer({
        items: [
          {
            connectionId: connection.connectionId,
            // Empty scope lists stay off the wire so the server defaults
            // (provider vocabulary, every resource) apply instead.
            actions: scope.actions.length > 0 ? scope.actions : undefined,
            resources: scope.resources.length > 0 ? scope.resources : undefined,
            expiresInSeconds: scope.expiresInSeconds,
            executionMode: scope.executionMode,
          },
        ],
      });
      // The mint succeeded; naming the identities against the connection is
      // additive and must not sink the grant when one of them fails.
      let bindWarning: string | null = null;
      if (assignment.kind === "bound") {
        const failures: string[] = [];
        for (const recipient of assignment.recipients) {
          const already = connection.bindings.some(
            (binding) =>
              binding.targetKind === recipient.kind &&
              binding.targetId === recipient.id,
          );
          if (already) continue;
          try {
            await bindConnection(connection.connectionId, {
              targetKind: recipient.kind,
              targetId: recipient.id,
            });
          } catch (caught) {
            failures.push(
              `${recipientLabel(recipient)} (${accessErrorText(caught)})`,
            );
          }
        }
        if (failures.length > 0) {
          bindWarning = failures.join("; ");
        }
      }
      onMinted(minted, bindWarning);
    } catch (caught) {
      setError(accessErrorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <dl className="grant-review">
        <div className="grant-review__row">
          <dt>For</dt>
          <dd>
            {assignmentLabel(assignment)}
            {assignment.kind !== "anyone" ? (
              <span className="grant-review__note"> — will be bound</span>
            ) : null}
          </dd>
        </div>
        <div className="grant-review__row">
          <dt>Target</dt>
          <dd>{targetName(target)}</dd>
        </div>
        <div className="grant-review__row">
          <dt>Connection</dt>
          <dd>
            <code>{connection?.connectionRef ?? "—"}</code>
          </dd>
        </div>
        <div className="grant-review__row">
          <dt>Actions</dt>
          <dd>{scope.actions.join(", ") || "Provider defaults"}</dd>
        </div>
        <div className="grant-review__row">
          <dt>Resources</dt>
          <dd>{scope.resources.join(", ") || "All resources"}</dd>
        </div>
        <div className="grant-review__row">
          <dt>Approval</dt>
          <dd>
            {scope.executionMode === "relay"
              ? "Relay — each use needs approval"
              : "Brokered"}
          </dd>
        </div>
        <div className="grant-review__row">
          <dt>Duration</dt>
          <dd>{formatDuration(scope.expiresInSeconds)}</dd>
        </div>
      </dl>

      {error ? (
        <p className="note note--err" role="alert">
          <IconAlert /> {error}
        </p>
      ) : null}

      <div className="actions">
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={onBack}
        >
          ← Scope
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={
            busy ||
            (connection !== null &&
              connection.connectionId !== "conn_local" &&
              !online)
          }
          onClick={() => void mint()}
        >
          {busy ? "Minting…" : "Mint offer"}
        </button>
      </div>
    </div>
  );
}

export function CodeCard({
  code,
  onDone,
}: { code: MintedCode; onDone: () => void }) {
  const { copy, copied } = useCopy();
  const now = useNow(30_000);

  return (
    <div>
      <div className="access-code">
        {code.assignment.kind !== "anyone" ? (
          <div className="access-code__row">
            <span className="access-code__label">For</span>
            <span>{assignmentLabel(code.assignment)}</span>
          </div>
        ) : null}
        <div className="access-code__row">
          <span className="access-code__label">Claim token</span>
          <code className="access-code__value">{code.claimToken}</code>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void copy(code.claimToken, "token")}
            title="Copy claim token"
            aria-label="Copy claim token"
          >
            {copied === "token" ? <IconCheck /> : <IconCopy />}
          </button>
        </div>
        <div className="access-code__row">
          <span className="access-code__label">User code</span>
          <code className="access-code__user">{code.userCode}</code>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void copy(code.userCode, "code")}
            title="Copy user code"
            aria-label="Copy user code"
          >
            {copied === "code" ? <IconCheck /> : <IconCopy />}
          </button>
        </div>
        <p className="access-code__expiry">
          Offer expires {countdown(code.expiresAt, now)}.
        </p>
      </div>

      {code.assignment.kind !== "anyone" ? (
        code.bindWarning ? (
          <p className="note note--warn">
            <IconAlert /> Minted, but the identity could not be bound:{" "}
            {code.bindWarning}
          </p>
        ) : (
          <p className="hint">Bound to the connection.</p>
        )
      ) : null}

      <div className="actions actions--end">
        <button type="button" className="btn btn--primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
