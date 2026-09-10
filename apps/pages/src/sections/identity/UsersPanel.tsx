import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  type DirectoryUser,
  createDirectoryUser,
  listDirectoryUsers,
  updateDirectoryUser,
} from "../../lib/identity-management.js";
import { type OrgMembership, listOrgMemberships } from "../../lib/orgs.js";

/** Provisioning reserves a directory identity; sign-in must still verify it. */
function useUsers() {
  const [organizations, setOrganizations] = useState<OrgMembership[]>([]);
  const [organization, setOrganization] = useState("");
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const [draft, setDraft] = useState<DirectoryUser | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const [memberships, rows] = await Promise.all([
        listOrgMemberships(),
        organization ? listDirectoryUsers(organization) : Promise.resolve([]),
      ]);
      if (current !== generation.current) return;
      setOrganizations(memberships.filter((org) => org.role === "owner"));
      setUsers(rows);
    } catch {
      if (current === generation.current) {
        setUsers([]);
        setError("Could not load the directory; confirm ownership and retry.");
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [organization]);
  useEffect(() => {
    setDraft(null);
    setUsers([]);
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  async function save(user: DirectoryUser) {
    setBusy(true);
    setError("");
    try {
      if (user.id) await updateDirectoryUser(organization, user);
      else
        await createDirectoryUser(
          organization,
          user.userName.trim(),
          user.displayName.trim(),
        );
      setDraft(null);
      await load();
    } catch {
      setError(
        "Could not save this user; check ownership and whether the username already exists.",
      );
    } finally {
      setBusy(false);
    }
  }

  return {
    organizations,
    organization,
    setOrganization,
    users,
    loading,
    error,
    draft,
    setDraft,
    busy,
    load,
    save,
  };
}

export function UsersPanel({ online }: { online: boolean }) {
  const model = useUsers();
  const {
    organizations,
    organization,
    setOrganization,
    users,
    loading,
    error,
    setDraft,
    busy,
    load,
  } = model;
  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Users</h2>
        <button
          type="button"
          className="btn btn--sm"
          disabled={!online || busy}
          onClick={() => void load()}
        >
          Reload users
        </button>
      </div>
      <div className="panel__body">
        <p className="hint">
          Create directory users here; their first verified organization sign-in
          establishes their OIDC identity.
        </p>
        {error ? (
          <p role="alert" className="note note--err">
            {error}
          </p>
        ) : null}
        {loading ? <output>Loading directory…</output> : null}
        {!loading && organizations.length === 0 ? (
          <p className="hint">
            User provisioning requires an organization you own —{" "}
            <Link to="/identity?view=organization">
              create or manage an organization
            </Link>
            .
          </p>
        ) : null}
        <div className="field">
          <label className="label" htmlFor="identity-directory-org">
            Organization
          </label>
          <select
            id="identity-directory-org"
            value={organization}
            disabled={busy || !online}
            onChange={(event) => setOrganization(event.target.value)}
          >
            <option value="">Choose an organization</option>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.displayName}
              </option>
            ))}
          </select>
        </div>
        {organization ? (
          <>
            <button
              type="button"
              className="btn btn--sm"
              disabled={!online || busy || loading}
              onClick={() =>
                setDraft({
                  id: "",
                  userName: "",
                  displayName: "",
                  active: true,
                })
              }
            >
              New user
            </button>
            {!loading && !error && users.length === 0 ? (
              <p className="hint">No directory users yet.</p>
            ) : null}
            <UsersRows model={model} online={online} />
          </>
        ) : null}
        <UsersForm model={model} online={online} />
      </div>
    </section>
  );
}

function UsersForm({
  model,
  online,
}: { model: ReturnType<typeof useUsers>; online: boolean }) {
  const { draft, setDraft, busy, save } = model;
  if (!draft) return null;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save(draft);
      }}
    >
      <div className="field">
        <label className="label" htmlFor="identity-user-name">
          Username / sign-in subject
        </label>
        <input
          id="identity-user-name"
          required
          maxLength={320}
          value={draft.userName}
          disabled={busy}
          onChange={(event) =>
            setDraft({ ...draft, userName: event.target.value })
          }
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="identity-user-display">
          Display name (optional)
        </label>
        <input
          id="identity-user-display"
          maxLength={512}
          value={draft.displayName}
          disabled={busy}
          onChange={(event) =>
            setDraft({ ...draft, displayName: event.target.value })
          }
        />
      </div>
      {draft.id ? (
        <label className="check">
          <input
            type="checkbox"
            checked={draft.active}
            disabled={busy}
            onChange={(event) =>
              setDraft({ ...draft, active: event.target.checked })
            }
          />{" "}
          Allow organization sign-in
        </label>
      ) : null}
      <p className="hint">
        Match the verified subject from your organization's sign-in provider;
        this does not set a password or mark an email as verified.
      </p>
      <div className="actions">
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy || !online || !draft.userName.trim()}
        >
          {busy ? "Saving…" : draft.id ? "Save user" : "Create user"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => setDraft(null)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function UsersRows({
  model,
  online,
}: { model: ReturnType<typeof useUsers>; online: boolean }) {
  const { users, busy, setDraft } = model;
  return (
    <ul className="identity-rows">
      {users.map((user) => (
        <li className="identity-row" key={user.id}>
          <div className="identity-row__main">
            <div className="identity-row__id">
              <h3>{user.displayName || user.userName}</h3>
              <code className="identity-ref">{user.userName}</code>
            </div>
            <span className="chip">{user.active ? "active" : "inactive"}</span>
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy || !online}
              onClick={() => setDraft(user)}
              aria-label={`Edit ${user.userName}`}
            >
              Edit
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
