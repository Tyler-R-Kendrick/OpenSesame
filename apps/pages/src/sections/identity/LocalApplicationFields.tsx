import {
  APPLICATION_ROLES,
  type LocalScopeRoles,
  defaultScopeRoles,
} from "@opensesame/app-core/lib/local-application-policy.js";
import type { LocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { StatusMark } from "../../components/StatusMark.js";

const TOO_MANY_SCOPES = "Use at most 32 scopes.";

export function ScopeRolesField({
  applicationId,
  scopes,
  value,
  onChange,
}: {
  /** Keys the tray notice, so two applications never share one. */
  applicationId: string;
  scopes: string;
  value: LocalScopeRoles[];
  onChange: (value: LocalScopeRoles[]) => void;
}) {
  const names = [...new Set(scopes.trim().split(/\s+/).filter(Boolean))];
  const tooMany = names.length > 32;
  const policy = defaultScopeRoles(tooMany ? [] : names).map(
    (fallback) => value.find((row) => row.scope === fallback.scope) ?? fallback,
  );
  return (
    <>
      <FailureNotice
        id={`identity:application-scopes:${applicationId}`}
        title="Scopes"
        message={tooMany ? TOO_MANY_SCOPES : null}
      />
      {tooMany ? (
        <StatusMark tone="err" label={TOO_MANY_SCOPES} />
      ) : (
        <ScopeRolesRows policy={policy} onChange={onChange} />
      )}
    </>
  );
}

function ScopeRolesRows({
  policy,
  onChange,
}: {
  policy: LocalScopeRoles[];
  onChange: (value: LocalScopeRoles[]) => void;
}) {
  return (
    <fieldset>
      <legend>Roles allowed per scope</legend>
      <p className="hint">
        Unchecked roles are denied, including owners. New custom scopes allow
        nobody until selected here. Sign-in still requires explicit consent.
      </p>
      {policy.map((entry) => (
        <fieldset key={entry.scope} className="field">
          <legend>{entry.scope}</legend>
          <div className="actions">
            {APPLICATION_ROLES.map((role) => (
              <label key={role}>
                <input
                  type="checkbox"
                  checked={entry.roles.includes(role)}
                  aria-label={`${entry.scope}: ${role}`}
                  onChange={(event) =>
                    onChange(
                      policy.map((row) =>
                        row.scope !== entry.scope
                          ? row
                          : {
                              scope: row.scope,
                              roles: event.target.checked
                                ? [...row.roles, role]
                                : row.roles.filter((held) => held !== role),
                            },
                      ),
                    )
                  }
                />{" "}
                {role}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </fieldset>
  );
}

export function OrganizationField({
  id,
  organizations,
  value,
  onChange,
}: {
  id: string;
  organizations: LocalDirectory["entries"];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <div className="field">
        <label className="label" htmlFor={`${id}-org`}>
          Organization
        </label>
        <select
          id={`${id}-org`}
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Select an organization</option>
          {organizations.map((org) => (
            <option key={org.id} value={org.id}>
              {org.name}
            </option>
          ))}
        </select>
      </div>
      {organizations.length === 0 ? (
        <p className="hint">
          Create an organization and assign its first owner in Organization
          before registering an application.
        </p>
      ) : null}
    </>
  );
}
