import type { OrganizationRole } from "@opensesame/os-domain";
import { useId, useRef, useState } from "react";
import type {
  LocalDirectory,
  LocalDirectoryChange,
} from "../../lib/local-directory.js";

type MembershipProps = {
  directory: LocalDirectory;
  organizationId: string;
  disabled: boolean;
  onChange: (change: LocalDirectoryChange) => Promise<void>;
};

export function LocalMemberships(props: MembershipProps) {
  const { directory, organizationId, disabled, onChange } = props;
  const members = directory.memberships.filter(
    (row) => row.organizationId === organizationId,
  );
  const people = directory.entries.filter(
    (entry) => entry.kind === "person" || entry.kind === "agent",
  );
  const [removing, setRemoving] = useState<string | null>(null);
  const summary = useRef<HTMLElement>(null);
  return (
    <details>
      <summary ref={summary}>Members</summary>
      <p className="hint">
        Manage this organization as the vault custodian. Assign an enabled
        person as its first owner. Role changes require local sessions to sign
        in again.
      </p>
      <ul className="identity-passkeys">
        {members.map((member) => (
          <li key={member.principalId}>
            <div className="identity-row__main">
              <span>
                {
                  people.find((person) => person.id === member.principalId)
                    ?.name
                }
              </span>
              <span className="chip">{member.role}</span>
              <button
                type="button"
                className="btn btn--sm btn--danger"
                disabled={disabled}
                onClick={() => {
                  if (removing !== member.principalId) {
                    setRemoving(member.principalId);
                    return;
                  }
                  summary.current?.focus();
                  setRemoving(null);
                  void onChange({
                    action: "membership",
                    organizationId,
                    principalId: member.principalId,
                    role: null,
                  });
                }}
              >
                {removing === member.principalId
                  ? "Confirm removal"
                  : "Remove member"}
              </button>
              {removing === member.principalId ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={disabled}
                  onClick={(event) => {
                    const previous = event.currentTarget.previousElementSibling;
                    if (previous instanceof HTMLButtonElement) previous.focus();
                    setRemoving(null);
                  }}
                >
                  Keep member
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {!members.length ? (
        <p className="hint">No members. Add the first owner below.</p>
      ) : null}
      {!people.length ? (
        <p className="hint">
          Create a person in Identity → People before assigning an owner.
        </p>
      ) : (
        <MembershipForm {...props} />
      )}
    </details>
  );
}

function MembershipForm(props: MembershipProps) {
  const { directory, organizationId, disabled, onChange } = props;
  const members = directory.memberships.filter(
    (row) => row.organizationId === organizationId,
  );
  const people = directory.entries.filter(
    (entry) => entry.kind === "person" || entry.kind === "agent",
  );
  const [principalId, setPrincipalId] = useState("");
  const [role, setRole] = useState<OrganizationRole>(
    members.length ? "member" : "owner",
  );
  const selected = people.find((entry) => entry.id === principalId);
  const id = useId();

  function selectPerson(value: string) {
    setPrincipalId(value);
    const existing = members.find((row) => row.principalId === value);
    const person = people.find((entry) => entry.id === value);
    setRole(
      existing?.role ??
        (person?.kind === "person" && members.length === 0
          ? "owner"
          : "member"),
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!selected || disabled) return;
        void onChange({
          action: "membership",
          organizationId,
          principalId,
          role,
        });
      }}
    >
      <div className="field">
        <label className="label" htmlFor={`${id}-person`}>
          Person or agent
        </label>
        <select
          id={`${id}-person`}
          required
          disabled={disabled}
          value={principalId}
          onChange={(event) => selectPerson(event.target.value)}
        >
          <option value="">Choose an identity</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
              {person.enabled ? "" : " (disabled)"}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${id}-role`}>
          Organization role
        </label>
        <select
          id={`${id}-role`}
          disabled={disabled || selected?.kind === "agent"}
          value={role}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "owner" || value === "admin" || value === "member")
              setRole(value);
          }}
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
          <option value="owner">Owner</option>
        </select>
      </div>
      <button
        type="submit"
        className="btn btn--primary"
        disabled={disabled || !selected}
      >
        {members.some((row) => row.principalId === principalId)
          ? "Save role"
          : "Add member"}
      </button>
    </form>
  );
}
