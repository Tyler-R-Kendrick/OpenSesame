import {
  APPLICATION_ROLES,
  type LocalScopeRoles,
  defaultScopeRoles,
} from "../../lib/local-application-policy.js";
import type { LocalDirectory } from "../../lib/local-directory.js";

export function ScopeRolesField({
  scopes,
  value,
  onChange,
}: {
  scopes: string;
  value: LocalScopeRoles[];
  onChange: (value: LocalScopeRoles[]) => void;
}) {
  const names = [...new Set(scopes.trim().split(/\s+/).filter(Boolean))];
  if (names.length > 32) return <p role="alert">Use at most 32 scopes.</p>;
  const policy = defaultScopeRoles(names).map(
    (fallback) => value.find((row) => row.scope === fallback.scope) ?? fallback,
  );
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
