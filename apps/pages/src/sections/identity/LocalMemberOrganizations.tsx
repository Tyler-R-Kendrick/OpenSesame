/**
 * The signed-in member's organizations (ADR 0105): what a local session —
 * never the vault custodian — may read. Each organization is a native
 * disclosure; opening it reads its members through the same session.
 */
import type { LocalOrganizationMember } from "@opensesame/app-core/lib/local-organizations.js";
import { organizationRoleLabel } from "@opensesame/app-core/lib/local-rbac.js";
import type { LocalSession } from "@opensesame/app-core/lib/local-sessions.js";
import {
  listMemberOrganizations,
  organizationListStatus,
} from "@opensesame/app-core/sections/identity/member-organizations-model.js";
import { useEffect, useId, useState } from "react";
import { StatusMark } from "../../components/StatusMark.js";
import { LocalMemberRows } from "./LocalMemberOrganizationRows.js";

type Organization = Readonly<{
  id: string;
  name: string;
  role: LocalOrganizationMember["role"];
}>;

type Props = {
  tomb: string;
  /** The tab-owned handle itself; a copy carries no presentation authority. */
  session: LocalSession;
  /** A membership edit committed: every local session has just ended. */
  onChanged?: () => void;
};

export function LocalMemberOrganizations({ tomb, session, onChanged }: Props) {
  const [organizations, setOrganizations] = useState<Organization[] | null>(
    null,
  );
  const [error, setError] = useState("");
  const heading = useId();
  useEffect(() => {
    let active = true;
    setOrganizations(null);
    setError("");
    void listMemberOrganizations(tomb, session).then((outcome) => {
      if (!active) return;
      if (outcome.ok) setOrganizations(outcome.value);
      else setError(outcome.refusal);
    });
    return () => {
      active = false;
    };
  }, [tomb, session]);
  const status = organizationListStatus(organizations?.length ?? null, error);
  return (
    <section className="identity-orgs" aria-labelledby={heading}>
      <div className="identity-orgs__head">
        <span className="label" id={heading}>
          Organizations
        </span>
        <StatusMark tone={status.tone} label={status.label} />
      </div>
      {error ? (
        <span role="alert" className="visually-hidden">
          {error}
        </span>
      ) : (
        <output className="visually-hidden" aria-label="Organization status">
          {status.label}
        </output>
      )}
      {organizations?.length ? (
        <ul className="identity-passkeys">
          {organizations.map((organization) => (
            <li key={organization.id}>
              <MemberOrganization
                tomb={tomb}
                session={session}
                organization={organization}
                onChanged={onChanged}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function MemberOrganization({
  tomb,
  session,
  organization,
  onChanged,
}: Omit<Props, "onChanged"> & {
  organization: Organization;
  onChanged: Props["onChanged"];
}) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {organization.name}{" "}
        <span className="chip">{organizationRoleLabel(organization.role)}</span>
      </summary>
      {open ? (
        <LocalMemberRows
          tomb={tomb}
          session={session}
          organizationId={organization.id}
          onChanged={onChanged}
        />
      ) : null}
    </details>
  );
}
