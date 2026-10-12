import type { GuideTargetId } from "@opensesame/guide-lang";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { FieldRow } from "../../components/FieldRow.js";
import {
  RecordWorkspace,
  type WorkspaceRow,
} from "../../components/RecordWorkspace.js";
import { AccessPathbar } from "./AccessPathbar.js";

export function useAccessRecord(
  panel: string,
  view: string,
  legacyPrefix?: string,
) {
  const location = useLocation();
  const navigate = useNavigate();
  const hash = location.hash.slice(1);
  const prefix = `${panel}/`;
  const encoded = hash.startsWith(prefix)
    ? hash.slice(prefix.length)
    : panel === "identity-shares" && hash.startsWith("pending-")
      ? hash.slice("pending-".length)
      : legacyPrefix && hash.startsWith(legacyPrefix)
        ? hash.slice(legacyPrefix.length)
        : null;
  let id: string | null = null;
  try {
    id = encoded === null ? null : decodeURIComponent(encoded);
  } catch {
    /* Invalid public references select no record. */
  }
  const params = new URLSearchParams(location.search);
  const creating = params.get("draft") === "new";
  const listPath = `/access?view=${view}#${panel}`;
  const path = (record: string) =>
    `/access?view=${view}#${legacyPrefix ?? `${panel}/`}${encodeURIComponent(record)}`;
  return {
    id,
    creating,
    listPath,
    path,
    select: (record: string | null) =>
      navigate(record ? path(record) : listPath),
    setCreating: (next: boolean) =>
      navigate(next ? `/access?view=${view}&draft=new#${panel}` : listPath),
    close: () => navigate(listPath),
  };
}

export function AccessRecords({
  title,
  selection,
  rows,
  commands,
  children,
  detailOpen,
  status,
  emptyMessage,
  createGuide,
}: {
  title: string;
  selection: ReturnType<typeof useAccessRecord>;
  rows: WorkspaceRow[];
  commands?: ReactNode;
  children?: ReactNode;
  detailOpen?: boolean;
  status?: ReactNode;
  emptyMessage?: string;
  createGuide?: GuideTargetId;
}) {
  return (
    <RecordWorkspace
      section="Access"
      title={title}
      createGuide={createGuide}
      rootPath="/access"
      listPath={selection.listPath}
      rows={rows}
      selectedId={
        rows.some((row) => row.id === selection.id) ? selection.id : null
      }
      detailOpen={detailOpen ?? selection.creating}
      status={status}
      emptyMessage={emptyMessage}
      commands={
        <>
          {commands}
          <AccessPathbar />
        </>
      }
    >
      {children}
    </RecordWorkspace>
  );
}

export function AccessDetail({
  title,
  kind,
  actions,
  children,
}: { title: string; kind: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="detail">
      <div className="detail__head">
        <div className="detail__heading">
          <h1>{title}</h1>
          <div className="detail__meta">
            <span>{kind}</span>
          </div>
        </div>
        <div className="detail__tools">{actions}</div>
      </div>
      {children}
    </div>
  );
}

export function AccessFact({
  label,
  value,
}: { label: string; value: ReactNode }) {
  return <FieldRow label={label}>{value}</FieldRow>;
}
