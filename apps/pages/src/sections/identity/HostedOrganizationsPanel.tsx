import type { IdentitySession } from "@opensesame/app-core/lib/identity.js";
import {
  type OrgMembership,
  listOrgMemberships,
} from "@opensesame/app-core/lib/orgs.js";
import { identityErrorText } from "@opensesame/app-core/sections/identity-section-model.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey, ReloadKey } from "../../components/IconKey.js";
import { IconEdit, IconPlus, IconUser, IconX } from "../../components/Icons.js";
import { RecordWorkspace } from "../../components/RecordWorkspace.js";

import * as Directory from "./DirectoryTabs.js";
import {
  HostedConnectWorkspace,
  HostedDetailHead,
  HostedFact,
  useHostedRecord,
} from "./HostedRecordParts.js";
import { useDirectoryPanels } from "./directory-panel-slot.js";
import { usePublishHostedIdentityRows } from "./hosted-identity-rail.js";

import { CreateOrgForm } from "./HostedIdentityForms.js";
function useOrganizationWorkspace(session: IdentitySession | null) {
  const [orgs, setOrgs] = useState<OrgMembership[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);
  const route = useHostedRecord("organization");
  const railRows = useMemo(
    () =>
      session
        ? orgs.map((row) => ({ id: row.id, label: row.displayName }))
        : [],
    [session, orgs],
  );
  usePublishHostedIdentityRows("organization", railRows);
  const selected = orgs.find((org) => org.id === route.selectedId);
  const load = useCallback(async () => {
    const id = ++run.current;
    setLoading(true);
    try {
      const rows = await listOrgMemberships();
      if (run.current === id) {
        setOrgs(rows);
        setError(null);
      }
    } catch (caught) {
      if (run.current === id) {
        setOrgs([]);
        setError(identityErrorText(caught));
      }
    } finally {
      if (run.current === id) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (session) void load();
    return () => {
      run.current += 1;
    };
  }, [load, session]);
  return { orgs, loading, error, route, selected, load };
}
export function OrganizationPanel({
  online,
  session,
  onOpenPeople,
}: {
  online: boolean;
  session: IdentitySession | null;
  onOpenPeople: () => void;
}) {
  const { orgs, loading, error, route, selected, load } =
    useOrganizationWorkspace(session);
  if (!session)
    return (
      <HostedConnectWorkspace
        online={online}
        title="Organizations"
        view="organization"
      />
    );
  return (
    <RecordWorkspace
      section="Identity"
      title="Organizations"
      rootPath="/identity"
      listPath={route.listPath}
      rows={orgs.map((org) => ({
        id: org.id,
        label: org.displayName,
        extension: "organization",
        to: `${route.listPath}#${encodeURIComponent(org.id)}`,
      }))}
      selectedId={route.selectedId}
      detailOpen={route.creating || Boolean(selected)}
      status={
        <>
          <FailureNotice
            id="identity:organizations"
            title="Organizations"
            message={error}
          />
          {loading ? <output>Loading organizations…</output> : null}
        </>
      }
      commands={
        <>
          <IconKey
            label="New organization"
            small
            disabled={!online}
            onClick={route.create}
          >
            <IconPlus size={15} />
          </IconKey>
          <ReloadKey
            label="Reload organizations"
            disabled={!online}
            onReload={() => void load()}
          />
        </>
      }
    >
      {route.creating ? (
        <>
          <HostedDetailHead title="New organization" />
          <CreateOrgForm
            online={online}
            onCancel={route.close}
            onCreated={(id) => {
              void load();
              route.open(id);
            }}
          />
        </>
      ) : selected ? (
        <OrganizationDetail
          selected={selected}
          online={online}
          onOpenPeople={onOpenPeople}
        />
      ) : null}
    </RecordWorkspace>
  );
}

function OrganizationDetail({
  selected,
  online,
  onOpenPeople,
}: { selected: OrgMembership; online: boolean; onOpenPeople: () => void }) {
  const route = useHostedRecord("organization");
  const directory = useDirectoryPanels();
  return (
    <>
      <HostedDetailHead
        title={selected.displayName}
        tools={
          <>
            <IconKey label="View people" onClick={onOpenPeople}>
              <IconUser size={16} />
            </IconKey>
            {directory && selected.role === "owner" ? (
              <IconKey
                label="Edit organization sign-in"
                disabled={!online}
                onClick={() => route.edit(selected.id)}
              >
                <IconEdit size={16} />
              </IconKey>
            ) : null}
          </>
        }
      />
      <HostedFact label="Organization ID">{selected.id}</HostedFact>
      <HostedFact label="Slug">{selected.slug}</HostedFact>
      <HostedFact label="Role">{selected.role}</HostedFact>
      {selected.ssoIssuer || selected.samlIssuer ? (
        <HostedFact label="Sign-in issuer">
          {selected.ssoIssuer ?? selected.samlIssuer}
        </HostedFact>
      ) : null}
      {route.editing && selected.role === "owner" ? (
        <>
          <Directory.DirectoryOrgSignIn
            online={online}
            known={selected}
            selectedOrg={selected.id}
          />
          <IconKey label="Close sign-in settings" onClick={route.close}>
            <IconX size={16} />
          </IconKey>
        </>
      ) : null}
    </>
  );
}
