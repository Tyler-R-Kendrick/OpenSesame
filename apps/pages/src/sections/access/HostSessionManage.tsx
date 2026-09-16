/**
 * Grant / admit / revoke UI for one Host shared session.
 */

import { useState } from "react";
import {
  mirrorHostGrant,
  revokeMirroredHostGrant,
} from "../../lib/host-shared-session-store.js";
import { activeProject } from "../../lib/projects.js";
import {
  type GrantInput,
  type JoinRequestRow,
  type SharedSessionDetail,
  decideJoinRequest,
  grantSharedSession,
  revokeSharedSessionGrant,
} from "../../lib/shared-sessions.js";
import { vaultLabel } from "../../lib/vaults.js";
import { GrantFields, useGrantDraft } from "./HostGrantFields.js";

export function HostSessionManage({
  tomb,
  detail,
  requests,
  busy,
  items,
  itemLabels,
  onRefresh,
  onRun,
}: {
  tomb: string;
  detail: SharedSessionDetail;
  requests: JoinRequestRow[];
  busy: boolean;
  items: { id: string; label: string }[];
  itemLabels: Record<string, string>;
  onRefresh: () => void;
  onRun: (action: () => Promise<void>) => Promise<void>;
}) {
  const project = activeProject();
  const label = vaultLabel(project);

  return (
    <div className="stack" style={{ marginTop: "1rem" }}>
      <h3>{detail.displayName}</h3>
      <p className="hint">
        Operator {detail.operatorPrincipalId}
        {detail.closedAt ? " · closed" : ""}
      </p>
      <GrantForm
        busy={busy}
        items={items}
        onGrant={(input) =>
          void onRun(async () => {
            const grant = await grantSharedSession(detail.id, input);
            await mirrorHostGrant(tomb, detail.id, grant, {
              vaultLabel: label,
              itemLabels,
            });
            onRefresh();
          })
        }
      />
      {requests.length > 0 ? (
        <div className="stack">
          <p className="band">Join requests</p>
          <ul className="identity-rows">
            {requests.map((request) => (
              <li key={request.id} className="identity-row">
                <div className="identity-row__main">
                  <div className="identity-row__id">
                    <h3>{request.requesterPrincipalId}</h3>
                    <code className="identity-ref">
                      {request.note ?? "No note"}
                    </code>
                  </div>
                  <div className="actions">
                    <AdmitButton
                      busy={busy}
                      items={items}
                      onAdmit={(grant) =>
                        void onRun(async () => {
                          const decided = await decideJoinRequest(
                            detail.id,
                            request.id,
                            "admitted",
                            grant,
                          );
                          if (decided.grant)
                            await mirrorHostGrant(
                              tomb,
                              detail.id,
                              decided.grant,
                              { vaultLabel: label, itemLabels },
                            );
                          onRefresh();
                        })
                      }
                    />
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={busy}
                      onClick={() =>
                        void onRun(async () => {
                          await decideJoinRequest(
                            detail.id,
                            request.id,
                            "refused",
                          );
                          onRefresh();
                        })
                      }
                    >
                      Refuse
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="stack">
        <p className="band">Participants</p>
        <ul className="identity-rows">
          {detail.participants.map((participant) => {
            const grantId = participant.grantId;
            return (
              <li
                key={grantId ?? participant.principalId}
                className="identity-row"
              >
                <div className="identity-row__main">
                  <div className="identity-row__id">
                    <h3>{participant.principalId}</h3>
                    <code className="identity-ref">
                      {participant.role}
                      {participant.scope ? ` · ${participant.scope.kind}` : ""}{" "}
                      · until {new Date(participant.expiresAt).toLocaleString()}
                    </code>
                  </div>
                  {grantId ? (
                    <button
                      type="button"
                      className="btn btn--sm btn--danger"
                      disabled={busy}
                      onClick={() =>
                        void onRun(async () => {
                          await revokeSharedSessionGrant(detail.id, grantId);
                          await revokeMirroredHostGrant(
                            tomb,
                            detail.id,
                            participant.principalId,
                          );
                          onRefresh();
                        })
                      }
                    >
                      Revoke
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function GrantForm({
  busy,
  items,
  onGrant,
}: {
  busy: boolean;
  items: { id: string; label: string }[];
  onGrant: (input: GrantInput) => void;
}) {
  const draft = useGrantDraft(items);
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void draft.buildGrant(true).then((input) => {
          if (input) onGrant(input);
        });
      }}
    >
      <p className="band">Grant reach</p>
      <GrantFields draft={draft} showSubject />
      <button
        type="submit"
        className="btn btn--sm btn--primary"
        disabled={busy}
      >
        Grant
      </button>
    </form>
  );
}

function AdmitButton({
  busy,
  items,
  onAdmit,
}: {
  busy: boolean;
  items: { id: string; label: string }[];
  onAdmit: (input: GrantInput) => void;
}) {
  const draft = useGrantDraft(items);
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        className="btn btn--sm btn--primary"
        disabled={busy}
        onClick={() => setOpen(true)}
      >
        Admit…
      </button>
    );
  }
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void draft.buildGrant(false).then((input) => {
          if (input) onAdmit(input);
        });
      }}
    >
      <GrantFields draft={draft} showSubject={false} />
      <div className="actions">
        <button
          type="submit"
          className="btn btn--sm btn--primary"
          disabled={busy}
        >
          Admit
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
