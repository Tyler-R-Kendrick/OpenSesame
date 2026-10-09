import {
  type OAuthClient,
  listOAuthClients,
  revokeOAuthClient,
  rotateOAuthClient,
} from "@opensesame/app-core/lib/directory.js";
import {
  type IdentitySession,
  identityBase,
} from "@opensesame/app-core/lib/identity.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import {
  formatTime,
  identityErrorText,
} from "@opensesame/app-core/sections/identity-section-model.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey, ReloadKey } from "../../components/IconKey.js";
import {
  IconCheck,
  IconCopy,
  IconEdit,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from "../../components/Icons.js";
import { RecordWorkspace } from "../../components/RecordWorkspace.js";
import { StatusMark } from "../../components/StatusMark.js";
import { StatusNote } from "../../components/StatusNote.js";

import { EditApplication } from "./EditApplication.js";
import {
  HostedConnectWorkspace,
  HostedDetailHead,
  HostedFact,
  useHostedRecord,
} from "./HostedRecordParts.js";
import { usePublishHostedIdentityRows } from "./hosted-identity-rail.js";

import { CreateClientForm } from "./HostedIdentityForms.js";
import { useCopy } from "./HostedRecordParts.js";
/** Owned OIDC clients remain behind the hosted session boundary. */
function useApplicationWorkspace(session: IdentitySession | null) {
  const [clients, setClients] = useState<OAuthClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [rotated, setRotated] = useState<OAuthClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const run = useRef(0);
  const route = useHostedRecord("service-accounts");
  const railRows = useMemo(
    () =>
      session
        ? clients.map((row) => ({ id: row.id, label: row.displayName }))
        : [],
    [session, clients],
  );
  usePublishHostedIdentityRows("service-accounts", railRows);
  const selected = clients.find((client) => client.id === route.selectedId);
  const { copy, copied } = useCopy();
  const load = useCallback(async () => {
    const id = ++run.current;
    setLoading(true);
    try {
      const rows = await listOAuthClients();
      if (run.current === id) {
        setClients(rows);
        setError(null);
      }
    } catch (caught) {
      if (run.current === id) {
        setClients([]);
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
  async function rotate(client: OAuthClient) {
    setBusy(true);
    setFlash(null);
    setRotated(null);
    try {
      const next = await rotateOAuthClient(client.id);
      setRotated(next);
      await load();
      route.open(next.id);
    } catch (caught) {
      setFlash({ tone: "err", text: identityErrorText(caught) });
    } finally {
      setBusy(false);
    }
  }
  async function revoke(client: OAuthClient) {
    setBusy(true);
    setFlash(null);
    try {
      await revokeOAuthClient(client.id);
      setConfirmId(null);
      setRotated(null);
      await load();
    } catch (caught) {
      setFlash({ tone: "err", text: identityErrorText(caught) });
    } finally {
      setBusy(false);
    }
  }
  return {
    clients,
    loading,
    error,
    flash,
    rotated,
    busy,
    confirmId,
    setConfirmId,
    route,
    selected,
    copy,
    copied,
    load,
    rotate,
    revoke,
    setFlash,
  };
}

export function ServiceAccountsPanel({
  online,
  session,
}: { online: boolean; session: IdentitySession | null }) {
  const workspace = useApplicationWorkspace(session);
  const {
    clients,
    loading,
    error,
    flash,
    busy,
    route,
    selected,
    load,
    setFlash,
  } = workspace;
  if (!session)
    return (
      <HostedConnectWorkspace
        online={online}
        title="Applications"
        view="service-accounts"
      />
    );
  return (
    <RecordWorkspace
      section="Identity"
      title="Applications"
      rootPath="/identity"
      listPath={route.listPath}
      rows={clients.map((client) => ({
        id: client.id,
        label: client.displayName,
        extension: "application",
        to: `${route.listPath}#${encodeURIComponent(client.id)}`,
      }))}
      selectedId={route.selectedId}
      detailOpen={route.creating || Boolean(selected)}
      status={
        <>
          <FailureNotice
            id="identity:applications"
            title="Applications"
            message={error}
          />
          {loading ? <output>Loading applications…</output> : null}
          <StatusNote title="Applications" message={flash} />
        </>
      }
      commands={
        <>
          <IconKey
            label="New application"
            small
            disabled={!online || busy}
            onClick={route.create}
          >
            <IconPlus size={15} />
          </IconKey>
          <ReloadKey
            label="Reload clients"
            disabled={!online || busy}
            onReload={() => void load()}
          />
        </>
      }
    >
      {route.creating ? (
        <>
          <HostedDetailHead title="New application" />
          <CreateClientForm
            online={online}
            onCancel={route.close}
            onCreated={(id) => {
              void load();
              route.open(id);
            }}
            onFlash={setFlash}
          />
        </>
      ) : selected ? (
        <ApplicationDetail
          selected={selected}
          workspace={workspace}
          online={online}
        />
      ) : null}
      <RotatedClient workspace={workspace} />
    </RecordWorkspace>
  );
}

function ApplicationDetail({
  selected,
  workspace,
  online,
}: {
  selected: OAuthClient;
  workspace: ReturnType<typeof useApplicationWorkspace>;
  online: boolean;
}) {
  const { route, load } = workspace;
  return (
    <>
      <HostedDetailHead
        title={selected.displayName}
        tools={
          <ApplicationTools
            selected={selected}
            workspace={workspace}
            online={online}
          />
        }
      />
      {route.editing ? (
        <EditApplication
          key={selected.id}
          client={selected}
          online={online}
          onSaved={() => {
            route.close();
            void load();
          }}
          onCancel={route.close}
        />
      ) : (
        <ApplicationFacts selected={selected} />
      )}
    </>
  );
}
function ApplicationTools({
  selected,
  workspace,
  online,
}: {
  selected: OAuthClient;
  workspace: ReturnType<typeof useApplicationWorkspace>;
  online: boolean;
}) {
  const { route, busy, confirmId, setConfirmId, rotate, revoke } = workspace;
  return route.editing ? null : (
    <>
      <IconKey
        label="Edit application"
        disabled={busy || !online || selected.state === "revoked"}
        onClick={() => route.edit(selected.id)}
      >
        <IconEdit size={16} />
      </IconKey>
      <IconKey
        label="Rotate client ID"
        disabled={busy || !online}
        onClick={() => void rotate(selected)}
      >
        <IconRefresh size={16} />
      </IconKey>
      <IconKey
        label={confirmId === selected.id ? "Revoke it" : "Revoke"}
        disabled={busy || !online}
        onClick={() => {
          if (confirmId === selected.id) void revoke(selected);
          else setConfirmId(selected.id);
        }}
      >
        <IconTrash size={16} />
      </IconKey>
      {confirmId === selected.id ? (
        <IconKey
          label="Keep it"
          disabled={busy}
          onClick={() => setConfirmId(null)}
        >
          <IconX size={16} />
        </IconKey>
      ) : null}
    </>
  );
}
function ApplicationFacts({ selected }: { selected: OAuthClient }) {
  const { copy, copied } = useCopy();
  return (
    <>
      <HostedFact
        label="Client ID"
        actions={
          <IconKey
            label="Copy client id"
            onClick={() => copy(selected.id, "client")}
          >
            {copied === "client" ? <IconCheck /> : <IconCopy />}
          </IconKey>
        }
      >
        {selected.id}
      </HostedFact>
      <HostedFact label="State">
        <StatusMark
          tone={selected.state === "active" ? "ok" : "warn"}
          label={selected.state}
        />
      </HostedFact>
      <HostedFact label="Admission">{selected.admissionMode}</HostedFact>
      <HostedFact label="Redirect URIs">
        {selected.redirectUris.join("\n")}
      </HostedFact>
      <HostedFact label="Sector identifier">
        {selected.sectorIdentifier}
      </HostedFact>
      <HostedFact label="Authentication">
        {selected.tokenEndpointAuthMethod}
      </HostedFact>
      <HostedFact label="Scopes">{selected.allowedScopes.join(" ")}</HostedFact>
      <HostedFact label="Created">{formatTime(selected.createdAt)}</HostedFact>
      <HostedFact label="OIDC discovery">
        <a
          href={`${identityBase()}/.well-known/openid-configuration`}
          target="_blank"
          rel="noreferrer"
        >
          Open OIDC discovery
        </a>
      </HostedFact>
    </>
  );
}
function RotatedClient({
  workspace,
}: { workspace: ReturnType<typeof useApplicationWorkspace> }) {
  const { rotated, copy, copied } = workspace;
  return (
    <>
      {rotated ? (
        <output className="note note--ok">
          <IconCheck /> New client id: <code>{rotated.id}</code>
          <IconKey
            label="Copy new client id"
            onClick={() => copy(rotated.id, "rotated")}
          >
            {copied === "rotated" ? <IconCheck /> : <IconCopy />}
          </IconKey>
        </output>
      ) : null}
    </>
  );
}
