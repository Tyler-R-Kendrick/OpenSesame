import {
  type DirectoryPrincipal,
  type LinkedIdentity,
  type OrgMember,
  addOrgMember,
  getMe,
  listLinkedIdentities,
  listOrgMembers,
  removeOrgMember,
  unlinkIdentity,
} from "@opensesame/app-core/lib/directory.js";
import type { IdentitySession } from "@opensesame/app-core/lib/identity.js";
import {
  GUEST_PROFILE_ID,
  activeOrgProfileId,
  listOrgMemberships,
} from "@opensesame/app-core/lib/orgs.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import {
  formatTime,
  identityErrorText,
  stateChip,
} from "@opensesame/app-core/sections/identity-section-model.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey, ReloadKey } from "../../components/IconKey.js";
import {
  IconCheck,
  IconCopy,
  IconPlus,
  IconTrash,
  IconX,
} from "../../components/Icons.js";
import {
  RecordWorkspace,
  type WorkspaceRow,
} from "../../components/RecordWorkspace.js";
import { StatusMark, statusTone } from "../../components/StatusMark.js";
import { StatusNote } from "../../components/StatusNote.js";

import * as Directory from "./DirectoryTabs.js";
import { MemberForm } from "./HostedMemberForm.js";
import {
  HostedConnectWorkspace,
  HostedDetailHead,
  HostedFact,
  useCopy,
  useHostedRecord,
} from "./HostedRecordParts.js";
import { useDirectoryPanels } from "./directory-panel-slot.js";
import { usePublishHostedIdentityRows } from "./hosted-identity-rail.js";
export function PeoplePanel({
  online,
  session,
}: { online: boolean; session: IdentitySession | null }) {
  const location = useLocation();
  const directory = useDirectoryPanels();
  if (!session)
    return (
      <HostedConnectWorkspace online={online} title="People" view="people" />
    );
  if (
    directory &&
    new URLSearchParams(location.search).get("directory") === "1"
  )
    return <Directory.DirectoryPeople online={online} />;
  return <HostedPeople online={online} directory={Boolean(directory)} />;
}

function useHostedPeople() {
  const profileId = activeOrgProfileId();
  const [me, setMe] = useState<DirectoryPrincipal | null>(null);
  const [identities, setIdentities] = useState<LinkedIdentity[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [owner, setOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const id = ++generation.current;
    setLoading(true);
    const results = await Promise.allSettled([
      getMe(),
      listLinkedIdentities(),
      profileId === GUEST_PROFILE_ID
        ? Promise.resolve([])
        : listOrgMembers(profileId),
      profileId === GUEST_PROFILE_ID
        ? Promise.resolve([])
        : listOrgMemberships(),
    ]);
    if (id !== generation.current) return;
    const [principal, linked, people, orgs] = results;
    setMe(principal.status === "fulfilled" ? principal.value : null);
    setIdentities(linked.status === "fulfilled" ? linked.value : []);
    setMembers(people.status === "fulfilled" ? people.value : []);
    setOwner(
      orgs.status === "fulfilled" &&
        orgs.value.some((org) => org.id === profileId && org.role === "owner"),
    );
    const failure = results.find((result) => result.status === "rejected");
    setError(
      failure?.status === "rejected" ? identityErrorText(failure.reason) : null,
    );
    setLoading(false);
  }, [profileId]);
  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);
  return { me, identities, members, owner, loading, error, load, profileId };
}

function usePeopleWorkspace(directory: boolean) {
  const model = useHostedPeople();
  const route = useHostedRecord("people");
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const linked = model.identities.find(
    (row) => `linked:${row.id}` === route.selectedId,
  );
  const member = model.members.find(
    (row) => `member:${row.principalId}` === route.selectedId,
  );
  const me = route.selectedId === model.me?.id ? model.me : null;
  async function mutate(task: () => Promise<void>, nextId?: string) {
    setBusy(true);
    setFlash(null);
    try {
      await task();
      setConfirmId(null);
      await model.load();
      if (nextId) route.open(nextId);
      else route.leave();
    } catch (caught) {
      setFlash({ tone: "err", text: identityErrorText(caught) });
    } finally {
      setBusy(false);
    }
  }
  const title =
    linked?.displayHint ?? linked?.issuer ?? member?.principalId ?? "You";
  const rows = useMemo(() => {
    const records: WorkspaceRow[] = [
      ...(model.me
        ? [{ id: model.me.id, label: "You", extension: "person" }]
        : []),
      ...model.identities.map((row) => ({
        id: `linked:${row.id}`,
        label: row.displayHint ?? row.issuer,
        extension: "identity",
      })),
      ...model.members.map((row) => ({
        id: `member:${row.principalId}`,
        label: row.principalId,
        extension: "member",
      })),
      ...(directory
        ? [
            {
              id: "directory",
              label: "Directory users",
              extension: "/",
              to: "/identity?view=people&directory=1",
            },
          ]
        : []),
    ];
    return records.map((row) => ({
      ...row,
      to: row.to ?? `${route.listPath}#${encodeURIComponent(row.id)}`,
    }));
  }, [model.me, model.identities, model.members, directory, route.listPath]);
  const railRows = useMemo(
    () => rows.filter((row) => row.id !== "directory"),
    [rows],
  );
  usePublishHostedIdentityRows("people", railRows);
  return {
    model,
    route,
    busy,
    confirmId,
    setConfirmId,
    flash,
    linked,
    member,
    me,
    mutate,
    title,
    rows,
  };
}

function HostedPeople({
  online,
  directory,
}: { online: boolean; directory: boolean }) {
  const workspace = usePeopleWorkspace(directory);
  const { model, route, busy, flash, linked, member, me, mutate, rows } =
    workspace;
  return (
    <RecordWorkspace
      section="Identity"
      title="People"
      rootPath="/identity"
      listPath={route.listPath}
      rows={rows}
      selectedId={route.selectedId}
      detailOpen={route.creating || Boolean(me || linked || member)}
      status={
        <>
          <FailureNotice
            id="identity:people"
            title="People"
            message={model.error}
          />
          {model.loading ? <output>Loading people…</output> : null}
          <StatusNote title="People" message={flash} />
        </>
      }
      commands={
        <>
          <IconKey
            label="New member"
            small
            disabled={!online || busy || !model.owner}
            onClick={route.create}
          >
            <IconPlus size={15} />
          </IconKey>
          <ReloadKey
            label="Reload people"
            disabled={!online || busy}
            onReload={() => void model.load()}
          />
        </>
      }
    >
      {route.creating && model.owner ? (
        <>
          <HostedDetailHead title="New member" />
          <MemberForm
            online={online}
            busy={busy}
            onCancel={route.close}
            onAdd={(principal, role) =>
              void mutate(async () => {
                await addOrgMember(model.profileId, principal, role);
              }, `member:${principal}`)
            }
          />
        </>
      ) : null}
      {!route.creating && (me || linked || member) ? (
        <PeopleDetail workspace={workspace} online={online} />
      ) : null}
    </RecordWorkspace>
  );
}

function PeopleDetail({
  workspace,
  online,
}: { workspace: ReturnType<typeof usePeopleWorkspace>; online: boolean }) {
  const { title } = workspace;
  return (
    <>
      <HostedDetailHead
        title={title}
        tools={<PeopleTools workspace={workspace} online={online} />}
      />
      <PeopleFacts workspace={workspace} />
    </>
  );
}

function PeopleTools({
  workspace,
  online,
}: { workspace: ReturnType<typeof usePeopleWorkspace>; online: boolean }) {
  const {
    linked,
    member,
    model,
    route,
    busy,
    confirmId,
    setConfirmId,
    mutate,
  } = workspace;
  return linked || (member && model.owner) ? (
    <>
      <IconKey
        label={
          confirmId === route.selectedId
            ? "Confirm removal"
            : linked
              ? "Unlink identity"
              : "Remove member"
        }
        disabled={!online || busy}
        onClick={() => {
          if (confirmId === route.selectedId)
            void mutate(async () => {
              if (linked) await unlinkIdentity(linked.id);
              else if (member)
                await removeOrgMember(
                  member.organizationId,
                  member.principalId,
                );
            });
          else setConfirmId(route.selectedId);
        }}
      >
        <IconTrash size={16} />
      </IconKey>
      {confirmId === route.selectedId ? (
        <IconKey
          label="Keep it"
          disabled={busy}
          onClick={() => setConfirmId(null)}
        >
          <IconX size={16} />
        </IconKey>
      ) : null}
    </>
  ) : null;
}

function PeopleFacts({
  workspace,
}: { workspace: ReturnType<typeof usePeopleWorkspace> }) {
  const { me, linked, member } = workspace;
  const { copy, copied } = useCopy();
  return (
    <>
      {me ? (
        <>
          <HostedFact
            label="Principal"
            actions={
              <IconKey
                label="Copy principal id"
                onClick={() => copy(me.id, "principal")}
              >
                {copied === "principal" ? <IconCheck /> : <IconCopy />}
              </IconKey>
            }
          >
            {me.id}
          </HostedFact>
          <HostedFact label="State">
            <StatusMark
              tone={statusTone(stateChip(me.state).tone)}
              label={stateChip(me.state).label}
            />
          </HostedFact>
          <HostedFact label="Assurance">{me.assurance}</HostedFact>
          <HostedFact label="Created">{formatTime(me.createdAt)}</HostedFact>
        </>
      ) : null}
      {linked ? (
        <>
          <HostedFact label="Issuer">{linked.issuer}</HostedFact>
          <HostedFact label="Kind">{linked.kind}</HostedFact>
          <HostedFact label="Assurance">{linked.assurance}</HostedFact>
          {linked.linkedAt ? (
            <HostedFact label="Linked">
              {formatTime(linked.linkedAt)}
            </HostedFact>
          ) : null}
        </>
      ) : null}
      {member ? (
        <>
          <HostedFact label="Principal">{member.principalId}</HostedFact>
          <HostedFact label="Role">{member.role}</HostedFact>
          <HostedFact label="Organization">{member.organizationId}</HostedFact>
        </>
      ) : null}
    </>
  );
}
