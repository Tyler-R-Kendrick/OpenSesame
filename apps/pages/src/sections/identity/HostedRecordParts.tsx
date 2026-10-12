import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router";
import { FieldRow } from "../../components/FieldRow.js";
import { IconKey } from "../../components/IconKey.js";
import { IconPlus } from "../../components/Icons.js";
import { RecordWorkspace } from "../../components/RecordWorkspace.js";
import { ConnectIdentityNote } from "./ConnectIdentityNote.js";

function stripEditorFlags(search: string) {
  const params = new URLSearchParams(search);
  params.delete("new");
  params.delete("edit");
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Hosted records use the same addressable selection and editor as the vault. */
export function useHostedRecord(view: string, extra = "") {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  let selectedId: string | null = null;
  try {
    selectedId = location.hash
      ? decodeURIComponent(location.hash.slice(1))
      : null;
  } catch {
    /* Ignore malformed fragment. */
  }
  const listPath = `/identity?view=${view}${extra}`;
  return {
    selectedId,
    creating: params.get("new") === "1",
    editing: params.get("edit") === "1",
    listPath,
    open: (id: string) =>
      navigate({
        pathname: location.pathname,
        search: stripEditorFlags(location.search),
        hash: `#${encodeURIComponent(id)}`,
      }),
    leave: () =>
      navigate({
        pathname: location.pathname,
        search: stripEditorFlags(location.search),
        hash: "",
      }),
    create: () => navigate(`${listPath}&new=1`),
    edit: (id: string) =>
      navigate(`${listPath}&edit=1#${encodeURIComponent(id)}`),
    close: () =>
      navigate({
        pathname: location.pathname,
        search: stripEditorFlags(location.search),
        hash: selectedId ? `#${encodeURIComponent(selectedId)}` : "",
      }),
  };
}

export function HostedDetailHead({
  title,
  tools,
}: { title: string; tools?: ReactNode }) {
  return (
    <div className="detail__head">
      <div className="detail__heading">
        <h1>{title}</h1>
      </div>
      <div className="detail__tools">{tools}</div>
    </div>
  );
}

export function HostedFact({
  label,
  children,
  actions,
}: { label: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <FieldRow label={label} actions={actions}>
      <span className="frow__value">{children}</span>
    </FieldRow>
  );
}

export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  }, []);

  return { copy, copied };
}

export function HostedConnectWorkspace({
  online,
  view,
  title,
}: { online: boolean; view: string; title: string }) {
  return (
    <RecordWorkspace
      section="Identity"
      title={title}
      rootPath="/identity"
      listPath={`/identity?view=${view}`}
      rows={[]}
      selectedId={null}
      detailOpen
      commands={
        <IconKey
          label={
            view === "people"
              ? "New person"
              : view === "agents"
                ? "New agent"
                : view === "organization"
                  ? "New organization"
                  : "New application"
          }
          small
          disabled
        >
          <IconPlus size={15} />
        </IconKey>
      }
    >
      <ConnectIdentityNote online={online} what={title} />
    </RecordWorkspace>
  );
}
