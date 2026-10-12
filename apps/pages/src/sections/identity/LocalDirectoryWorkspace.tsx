import type {
  LocalIdentity,
  LocalIdentityKind,
} from "@opensesame/app-core/lib/local-directory.js";
import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { IconKey, ReloadKey } from "../../components/IconKey.js";
import { IconPlus } from "../../components/Icons.js";
import { RecordWorkspace } from "../../components/RecordWorkspace.js";
import { useVault } from "../../lib/vault/hooks.js";
import { IdentityFact } from "./IdentityRecordFields.js";
import { useDirectory } from "./LocalDirectoryPanel.js";
import {
  DirectoryAuthority,
  DirectoryForm,
  type DirectoryModel,
  DirectoryRowKeys,
  LABELS,
  newEntryKeyId,
} from "./LocalDirectoryViews.js";
import { LocalIdentityNotices } from "./LocalIdentityNotices.js";
import { identityRecordId } from "./identity-record-selection.js";

const KIND_VIEW = {
  person: "people",
  agent: "agents",
  application: "service-accounts",
  organization: "organization",
};

export function LocalDirectoryWorkspace({ kind }: { kind: LocalIdentityKind }) {
  const { tomb } = useVault();
  return <DirectoryWorkspace key={`${tomb}:${kind}`} tomb={tomb} kind={kind} />;
}

function DirectoryWorkspace({
  tomb,
  kind,
}: { tomb: string; kind: LocalIdentityKind }) {
  const navigate = useNavigate();
  const { hash } = useLocation();
  const [params] = useSearchParams();
  const selectedId = identityRecordId(hash);
  const action = params.get("action");
  const listPath = `/identity?view=${KIND_VIEW[kind]}`;
  const model = useDirectory(tomb, (next, command) => {
    const id =
      command.action === "create"
        ? next.entries.find(
            (entry) =>
              !model.directory?.entries.some(
                (before) => before.id === entry.id,
              ),
          )?.id
        : command.action === "delete"
          ? null
          : command.action === "membership"
            ? command.organizationId
            : command.id;
    navigate(id ? `${listPath}#${encodeURIComponent(id)}` : listPath, {
      replace: true,
    });
  });
  const { directory, draft, setDraft, busy, seeding, error, load } = model;
  const label = LABELS[kind];
  const entries =
    directory?.entries.filter((entry) => entry.kind === kind) ?? [];
  const selected = entries.find((entry) => entry.id === selectedId);
  useDirectoryDraft({ action, selectedId, kind, seeding, selected, setDraft });
  const editorModel = {
    ...model,
    setDraft: (value: typeof draft) => {
      if (value?.id && action !== "edit") {
        navigate(`${listPath}&action=edit#${encodeURIComponent(value.id)}`);
        return;
      }
      setDraft(value);
      if (!value)
        navigate(
          selected
            ? `${listPath}#${encodeURIComponent(selected.id)}`
            : listPath,
        );
    },
  };
  return (
    <RecordWorkspace
      section="Identity"
      title={label.heading}
      rootPath="/identity"
      listPath={listPath}
      rows={entries.map((entry) => ({
        id: entry.id,
        label: entry.name,
        extension: kind,
        to: `${listPath}#${encodeURIComponent(entry.id)}`,
      }))}
      selectedId={selectedId}
      detailOpen={!!draft || !!selected}
      status={
        <LocalIdentityNotices
          id="identity:local-directory"
          title={label.heading}
          error={error}
        />
      }
      commands={
        <fieldset
          className="vtree__keys"
          aria-label={`${label.heading} commands`}
        >
          <IconKey
            id={newEntryKeyId(kind)}
            label={`New ${label.singular}`}
            small
            disabled={busy || seeding || !directory || draft !== null}
            onClick={() => navigate(`${listPath}&action=new`)}
          >
            <IconPlus size={15} />
          </IconKey>
          <ReloadKey label="Reload directory" disabled={busy} onReload={load} />
        </fieldset>
      }
    >
      <DirectoryBuffer
        model={editorModel}
        kind={kind}
        tomb={tomb}
        selected={selected}
      />
    </RecordWorkspace>
  );
}

function useDirectoryDraft({
  action,
  selectedId,
  kind,
  seeding,
  selected,
  setDraft,
}: {
  action: string | null;
  selectedId: string | null;
  kind: LocalIdentityKind;
  seeding: boolean;
  selected?: LocalIdentity;
  setDraft: DirectoryModel["setDraft"];
}) {
  const draftRoute = useRef("");
  useEffect(() => {
    if (seeding || (action === "edit" && !selected)) return;
    const route = `${action}:${selectedId}`;
    if (draftRoute.current === route) return;
    draftRoute.current = route;
    if (action === "new") setDraft({ id: "", kind, name: "", enabled: true });
    else if (action === "edit" && selected) setDraft(selected);
    else setDraft(null);
  }, [action, selectedId, kind, seeding, selected, setDraft]);
}
function DirectoryBuffer({
  model,
  kind,
  tomb,
  selected,
}: {
  model: DirectoryModel;
  kind: LocalIdentityKind;
  tomb: string;
  selected?: LocalIdentity;
}) {
  const label = LABELS[kind];
  if (model.draft)
    return (
      <div className="detail">
        <div className="detail__head">
          <div className="detail__heading">
            <h1>
              {model.draft.id
                ? `Edit ${model.draft.name}`
                : `New ${label.singular}`}
            </h1>
          </div>
        </div>
        <DirectoryForm model={model} kind={kind} />
      </div>
    );
  if (!selected || !model.directory) return null;
  return (
    <div className="detail" id={selected.id}>
      <div className="detail__head">
        <div className="detail__heading">
          <h1>{selected.name}</h1>
          <div className="detail__meta">
            {label.singular} · {selected.enabled ? "Enabled" : "Disabled"}
          </div>
        </div>
        <DirectoryRowKeys model={model} entry={selected} kind={kind} />
      </div>
      <section className="detail__group">
        <h2 className="detail__grouphead">Identity</h2>
        <IdentityFact label="ID">{selected.id}</IdentityFact>
        <IdentityFact label="Status">
          {selected.enabled ? "Enabled" : "Disabled"}
        </IdentityFact>
      </section>
      <DirectoryAuthority
        tomb={tomb}
        entry={selected}
        directory={model.directory}
        disabled={model.busy || model.seeding}
        onChange={model.change}
      />
    </div>
  );
}
