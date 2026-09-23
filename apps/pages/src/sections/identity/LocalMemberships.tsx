import type {
  LocalDirectory,
  LocalDirectoryChange,
} from "@opensesame/app-core/lib/local-directory.js";
import {
  accessRoleLabel,
  isGuestIdentity,
  organizationRoleLabel,
  resolveAccessRole,
} from "@opensesame/app-core/lib/local-rbac.js";
import type { OrganizationRole } from "@opensesame/os-domain";
import { useId, useRef, useState } from "react";

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
        Organization roles map to Access RBAC: Owner/Admin are Operators, Member
        is Member, and Guest N stays Guest. Guests cannot be operators once
        another person is assigned. Role changes require local sessions to sign
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
              <span className="chip">
                {organizationRoleLabel(member.role)}
                {" · "}
                {accessRoleLabel(
                  resolveAccessRole(directory, member.principalId) ?? "member",
                )}
              </span>
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
    if (person && isGuestIdentity(person)) {
      setRole("member");
      return;
    }
    setRole(
      existing?.role ??
        (person?.kind === "person" && members.length === 0
          ? "owner"
          : "member"),
    );
  }

  const guestSelected = selected ? isGuestIdentity(selected) : false;
  const alreadyMember = members.some((row) => row.principalId === principalId);
  const submitLabel = alreadyMember ? "Save role" : "Add member";

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        const selects = event.currentTarget.querySelectorAll("select");
        const personControl = selects.item(0);
        const roleControl = selects.item(1);
        if (!(personControl instanceof HTMLSelectElement)) return;
        if (!(roleControl instanceof HTMLSelectElement)) return;
        const nextPrincipal = personControl.value;
        const nextRole = roleControl.value;
        if (!nextPrincipal) return;
        if (
          nextRole !== "owner" &&
          nextRole !== "admin" &&
          nextRole !== "member"
        )
          return;
        const chosen = people.find((entry) => entry.id === nextPrincipal);
        if (!chosen) return;
        void onChange({
          action: "membership",
          organizationId,
          principalId: nextPrincipal,
          role: nextRole,
        });
      }}
    >
      <div className="field">
        <label className="label" htmlFor={`${id}-person`}>
          Person or agent
        </label>
        <select
          id={`${id}-person`}
          name={`${id}-person`}
          required
          disabled={disabled}
          defaultValue=""
          onChange={(event) => selectPerson(event.currentTarget.value)}
          onKeyUp={(event) => selectPerson(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Enter inside a select submits the form; that must not assign
            // whatever option is under the caret mid-arrow navigation.
            if (event.key === "Enter") event.preventDefault();
          }}
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
          name={`${id}-role`}
          disabled={disabled || selected?.kind === "agent" || guestSelected}
          value={role}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "owner" || value === "admin" || value === "member")
              setRole(value);
          }}
        >
          <option value="member">{organizationRoleLabel("member")}</option>
          {guestSelected ? null : (
            <>
              <option value="admin">{organizationRoleLabel("admin")}</option>
              <option value="owner">{organizationRoleLabel("owner")}</option>
            </>
          )}
        </select>
      </div>
      <button
        type="submit"
        className="btn btn--sm btn--primary"
        disabled={disabled || !principalId}
      >
        {submitLabel}
      </button>
    </form>
  );
}
