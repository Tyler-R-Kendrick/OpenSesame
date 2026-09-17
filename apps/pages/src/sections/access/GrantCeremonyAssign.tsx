import { useState } from "react";
import { IconAlert } from "../../components/Icons.js";
import type { BindingTargetKind, Connection } from "../../lib/connections.js";
import {
  type Assignment,
  type GrantRecipient,
  type GrantTarget,
  recipientLabel,
} from "./grant-ceremony-types.js";

const RECIPIENT_KINDS: Array<{ id: BindingTargetKind; label: string }> = [
  { id: "agent", label: "Agent" },
  { id: "identity", label: "Person" },
  { id: "device", label: "Device" },
  { id: "group", label: "Group" },
  { id: "project", label: "Project" },
  { id: "organization", label: "Organization" },
];

export function AssignStep({
  target,
  connection,
  onBack,
  onAssign,
}: {
  target: GrantTarget;
  connection: Connection | null;
  onBack: (() => void) | null;
  onAssign: (assignment: Assignment) => void;
}) {
  const grantees = target.kind === "secret" ? target.secret.grantees : [];
  const boundAgents = (connection?.bindings ?? [])
    .filter((binding) => binding.targetKind === "agent")
    .map((binding) => binding.targetId);
  const suggestions = [...new Set([...grantees, ...boundAgents])];
  const [mode, setMode] = useState<"specific" | "anyone">(
    grantees.length > 0 ? "specific" : "anyone",
  );
  // A secret's grantees are its declared allow-list — they prefill the
  // recipient list (removable), never silently required.
  const [recipients, setRecipients] = useState<GrantRecipient[]>(() =>
    grantees.map((id) => ({ kind: "agent", id })),
  );
  const [kind, setKind] = useState<BindingTargetKind>("agent");
  const [idText, setIdText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  function addRecipient() {
    const id = idText.trim();
    if (id === "") {
      setProblem("Enter an id first.");
      return;
    }
    if (
      kind === "agent" &&
      target.kind === "secret" &&
      grantees.length > 0 &&
      !grantees.includes(id)
    ) {
      setProblem(`Not in this secret's grantees: ${grantees.join(", ")}.`);
      return;
    }
    if (recipients.some((entry) => entry.kind === kind && entry.id === id)) {
      setProblem("Already added.");
      return;
    }
    setRecipients([...recipients, { kind, id }]);
    setIdText("");
    setProblem(null);
  }

  const ready = mode === "anyone" || recipients.length > 0;

  function proceed() {
    if (mode === "anyone") onAssign({ kind: "anyone" });
    else onAssign({ kind: "bound", recipients });
  }

  return (
    <div>
      <fieldset className="grant-choices" aria-label="Who is this grant for">
        <button
          type="button"
          className={
            mode === "specific" ? "grant-choice is-on" : "grant-choice"
          }
          onClick={() => setMode("specific")}
        >
          Specific identities
        </button>
        <button
          type="button"
          className={mode === "anyone" ? "grant-choice is-on" : "grant-choice"}
          onClick={() => setMode("anyone")}
        >
          Anyone with the code
        </button>
      </fieldset>

      {mode === "specific" ? (
        <div>
          {recipients.length > 0 ? (
            <ul className="grant-recipients" aria-label="Grant recipients">
              {recipients.map((recipient) => (
                <li
                  key={`${recipient.kind}:${recipient.id}`}
                  className="grant-recipients__chip"
                >
                  {recipientLabel(recipient)}
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove ${recipientLabel(recipient)}`}
                    title={`Remove ${recipientLabel(recipient)}`}
                    onClick={() =>
                      setRecipients(
                        recipients.filter(
                          (entry) =>
                            !(
                              entry.kind === recipient.kind &&
                              entry.id === recipient.id
                            ),
                        ),
                      )
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No identities yet — add at least one.</p>
          )}

          <div className="grant-recipients__add">
            <select
              aria-label="Identity kind"
              value={kind}
              onChange={(event) => {
                const next = RECIPIENT_KINDS.find(
                  (entry) => entry.id === event.target.value,
                );
                if (next) setKind(next.id);
                setProblem(null);
              }}
            >
              {RECIPIENT_KINDS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
            <input
              aria-label="Identity id"
              value={idText}
              list="grant-recipient-suggestions"
              placeholder={
                kind === "agent"
                  ? "deploy-bot"
                  : kind === "identity"
                    ? "prn_…"
                    : `${kind} id`
              }
              onChange={(event) => setIdText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addRecipient();
                }
              }}
            />
            <datalist id="grant-recipient-suggestions">
              {suggestions.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            <button
              type="button"
              className="btn btn--sm"
              onClick={addRecipient}
            >
              Add
            </button>
          </div>
          {problem ? (
            <p className="note note--err" role="alert">
              <IconAlert /> {problem}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="actions">
        {onBack ? (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={onBack}
          >
            ← Target
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--primary"
          disabled={!ready}
          onClick={proceed}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
