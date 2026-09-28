/**
 * One organization's members as the signed-in member reads them. Keys appear
 * only where the session's role permits (ADR 0105); removal is the armed
 * key the custodian's Members disclosure uses, with Keep member beside it.
 * A refusal is a mark on the organization, never a box. Keys stay enabled
 * while a change is pending (the change itself refuses a second press), so
 * a focused key is never disabled out from under the keyboard.
 */
import type {
  LocalOrganizationMember,
  readLocalOrganization,
} from "@opensesame/app-core/lib/local-organizations.js";
import { organizationRoleLabel } from "@opensesame/app-core/lib/local-rbac.js";
import type { LocalSession } from "@opensesame/app-core/lib/local-sessions.js";
import {
  changeMemberOrganization,
  memberListStatus,
  memberRowKeys,
  readMemberOrganization,
} from "@opensesame/app-core/sections/identity/member-organizations-model.js";
import type { OrganizationRole } from "@opensesame/os-domain";
import { useEffect, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconCheck, IconTrash, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

type Detail = Awaited<ReturnType<typeof readLocalOrganization>>;

type Props = {
  tomb: string;
  session: LocalSession;
  organizationId: string;
  onChanged: (() => void) | undefined;
};

function useOrganizationDetail({
  tomb,
  session,
  organizationId,
  onChanged,
}: Props) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void readMemberOrganization(tomb, session, organizationId).then(
      (outcome) => {
        if (!active) return;
        if (outcome.ok) setDetail(outcome.value);
        else setError(outcome.refusal);
      },
    );
    return () => {
      active = false;
    };
  }, [tomb, session, organizationId]);
  async function change(principalId: string, role: OrganizationRole | null) {
    if (busy) return;
    setBusy(true);
    setError("");
    const outcome = await changeMemberOrganization(
      tomb,
      session,
      organizationId,
      principalId,
      role,
    );
    setBusy(false);
    if (outcome.ok) onChanged?.();
    else setError(outcome.refusal);
  }
  return { detail, error, busy, change };
}

export function LocalMemberRows(props: Props) {
  const { detail, error, busy, change } = useOrganizationDetail(props);
  const [removing, setRemoving] = useState<string | null>(null);
  const status = memberListStatus(detail?.members.length ?? null, error, busy);
  return (
    <div aria-busy={busy}>
      <div className="identity-orgs__head">
        <StatusMark tone={status.tone} label={status.label} />
      </div>
      {error ? (
        <span role="alert" className="visually-hidden">
          {error}
        </span>
      ) : (
        <output className="visually-hidden" aria-label="Membership status">
          {status.label}
        </output>
      )}
      <ul className="identity-passkeys">
        {detail?.members.map((member) => (
          <MemberRow
            key={member.principalId}
            member={member}
            session={props.session}
            sessionRole={detail.role}
            busy={busy}
            armed={removing === member.principalId}
            arm={(armed) => setRemoving(armed ? member.principalId : null)}
            change={(role) => void change(member.principalId, role)}
          />
        ))}
      </ul>
    </div>
  );
}

function MemberRow({
  member,
  session,
  sessionRole,
  busy,
  armed,
  arm,
  change,
}: {
  member: LocalOrganizationMember;
  session: LocalSession;
  sessionRole: OrganizationRole;
  busy: boolean;
  armed: boolean;
  arm: (armed: boolean) => void;
  change: (role: OrganizationRole | null) => void;
}) {
  const keys = memberRowKeys(session.authentication, sessionRole, member);
  const [draft, setDraft] = useState<OrganizationRole>(member.role);
  return (
    <li>
      <div className="identity-row__main">
        <div className="identity-row__id">
          <span>{member.name}</span>
          {keys.roles.length ? (
            <select
              aria-label={`Role for ${member.name}`}
              value={draft}
              disabled={busy}
              onChange={(event) => {
                const next = keys.roles.find(
                  (role) => role === event.target.value,
                );
                if (next) setDraft(next);
              }}
            >
              {keys.roles.map((role) => (
                <option key={role} value={role}>
                  {organizationRoleLabel(role)}
                </option>
              ))}
            </select>
          ) : (
            <span className="chip">{organizationRoleLabel(member.role)}</span>
          )}
        </div>
        {keys.roles.length || keys.remove ? (
          <div className="actions">
            {keys.roles.length ? (
              <IconKey
                label="Save role"
                small
                disabled={draft === member.role}
                onClick={() => change(draft)}
              >
                <IconCheck size={16} />
              </IconKey>
            ) : null}
            {keys.remove ? (
              <IconKey
                label={armed ? "Confirm removal" : "Remove member"}
                small
                danger
                armed={armed}
                onClick={() => {
                  arm(!armed);
                  if (armed) change(null);
                }}
              >
                <IconTrash size={16} />
              </IconKey>
            ) : null}
            {armed ? (
              <IconKey
                label="Keep member"
                small
                onClick={(event) => {
                  const previous = event.currentTarget.previousElementSibling;
                  arm(false);
                  if (previous instanceof HTMLButtonElement) previous.focus();
                }}
              >
                <IconX size={16} />
              </IconKey>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
