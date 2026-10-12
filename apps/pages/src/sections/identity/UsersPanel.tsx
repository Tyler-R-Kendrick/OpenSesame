import {
  type DirectoryUser,
  createDirectoryUser,
  listDirectoryUsers,
  updateDirectoryUser,
} from "@opensesame/app-core/lib/identity-management.js";
import {
  type OrgMembership,
  listOrgMemberships,
} from "@opensesame/app-core/lib/orgs.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { FailureNotice } from "../../components/FailureNotice.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import {
  IconEdit,
  IconPlus,
  IconRefresh,
  IconX,
} from "../../components/Icons.js";
import { RecordWorkspace } from "../../components/RecordWorkspace.js";
import { StatusMark } from "../../components/StatusMark.js";
import {
  HostedDetailHead,
  HostedFact,
  useHostedRecord,
} from "./HostedRecordParts.js";

/** Provisioning reserves a directory identity; sign-in must still verify it. */
function useUsers() {
  const [organizations, setOrganizations] = useState<OrgMembership[]>([]);
  const location = useLocation();
  const [organization, setOrganization] = useState(
    () => new URLSearchParams(location.search).get("org") ?? "",
  );
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
      const saved = user.id
        ? await updateDirectoryUser(organization, user)
        : await createDirectoryUser(
            organization,
            user.userName.trim(),
            user.displayName.trim(),
          );
      setDraft(null);
      await load();
      return saved.id;
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
  const route = useHostedRecord(
    "people",
    `&directory=1&org=${encodeURIComponent(model.organization)}`,
  );
  const { organization, users, loading, error, draft, setDraft, busy, load } =
    model;
  const selected = users.find((user) => user.id === route.selectedId);
  useEffect(() => {
    if (route.creating && organization)
      setDraft({ id: "", userName: "", displayName: "", active: true });
    else if (route.editing && selected) setDraft(selected);
    else setDraft(null);
  }, [route.creating, route.editing, organization, selected, setDraft]);
  return (
    <RecordWorkspace
      section="Identity"
      title="Directory users"
      rootPath="/identity"
      listPath={route.listPath}
      rows={users.map((user) => ({
        id: user.id,
        label: user.displayName || user.userName,
        extension: "person",
        to: `${route.listPath}#${encodeURIComponent(user.id)}`,
      }))}
      selectedId={route.selectedId}
      detailOpen={route.creating || Boolean(selected)}
      listHeader={<DirectoryOrganization model={model} online={online} />}
      status={
        <>
          <FailureNotice id="identity:users" title="Users" message={error} />
          {loading ? <output>Loading directory…</output> : null}
        </>
      }
      commands={
        <>
          <IconKey
            label="New user"
            small
            disabled={!online || busy || !organization}
            onClick={route.create}
          >
            <IconPlus size={15} />
          </IconKey>
          <IconKey
            label="Reload users"
            small
            disabled={!online || busy}
            onClick={() => void load()}
          >
            <IconRefresh size={15} />
          </IconKey>
        </>
      }
    >
      {draft ? (
        <>
          <HostedDetailHead
            title={
              draft.id
                ? `Edit ${draft.displayName || draft.userName}`
                : "New user"
            }
          />
          <UsersForm
            model={model}
            online={online}
            onCancel={route.close}
            onSaved={(id) => route.open(id)}
          />
        </>
      ) : selected ? (
        <UserDetail
          selected={selected}
          busy={busy}
          route={route}
          online={online}
        />
      ) : null}
    </RecordWorkspace>
  );
}

function UsersForm({
  model,
  online,
  onCancel,
  onSaved,
}: {
  model: ReturnType<typeof useUsers>;
  online: boolean;
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const { draft, setDraft, busy, save } = model;
  if (!draft) return null;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save(draft).then((id) => {
          if (id) onSaved(id);
        });
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
          title="Match the verified subject from your organization's sign-in provider; this does not set a password or mark an email as verified"
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
      <FormCommit
        label="Save user"
        disabled={busy || !online || !draft.userName.trim()}
      >
        <IconKey label="Cancel" disabled={busy} onClick={onCancel}>
          <IconX size={16} />
        </IconKey>
      </FormCommit>
    </form>
  );
}

function UserDetail({
  selected,
  busy,
  route,
  online,
}: {
  selected: DirectoryUser;
  busy: boolean;
  route: ReturnType<typeof useHostedRecord>;
  online: boolean;
}) {
  return (
    <>
      <HostedDetailHead
        title={selected.displayName || selected.userName}
        tools={
          <IconKey
            label={`Edit ${selected.userName}`}
            disabled={busy || !online}
            onClick={() => route.edit(selected.id)}
          >
            <IconEdit size={16} />
          </IconKey>
        }
      />
      <HostedFact label="Username / sign-in subject">
        {selected.userName}
      </HostedFact>
      <HostedFact label="User ID">{selected.id}</HostedFact>
      <HostedFact label="State">
        <StatusMark
          tone={selected.active ? "ok" : "idle"}
          label={selected.active ? "Active" : "Inactive"}
        />
      </HostedFact>
    </>
  );
}

function DirectoryOrganization({
  model,
  online,
}: { model: ReturnType<typeof useUsers>; online: boolean }) {
  const navigate = useNavigate();
  const { organization, setOrganization, organizations, busy, loading } = model;
  return (
    <>
      {!loading && organizations.length === 0 ? (
        <p className="hint">
          <Link to="/identity?view=organization&new=1">
            Create an organization
          </Link>
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
          onChange={(event) => {
            setOrganization(event.target.value);
            navigate(
              `/identity?view=people&directory=1&org=${encodeURIComponent(event.target.value)}`,
            );
          }}
        >
          <option value="">Choose an organization</option>
          {organizations.map((org) => (
            <option key={org.id} value={org.id}>
              {org.displayName}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
