import { useCallback, useEffect, useRef, useState } from "react";
import { IconPlus, IconRefresh } from "../../components/Icons.js";
import {
  type AccessRequest,
  getAccessRequest,
  getInboxRef,
  listAccessRequests,
} from "../../lib/access-requests.js";
import { useIdentitySession } from "../../lib/identity.js";
import { ConnectIdentityNote } from "../identity/ConnectIdentityNote.js";
import { ApprovalReview } from "./ApprovalReview.js";
import { RequestForm } from "./RequestForm.js";
import { SentRequest } from "./SentRequest.js";

function useInbox(online: boolean) {
  const [requests, setRequests] = useState<AccessRequest[] | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const load = useCallback(async () => {
    const run = ++generation.current;
    try {
      const rows = await listAccessRequests();
      if (run === generation.current) {
        setRequests(rows);
        setError("");
      }
    } catch {
      if (run === generation.current)
        setError("Cannot load Identity requests; retry when connected.");
    }
  }, []);
  useEffect(() => {
    if (online) void load();
    return () => {
      generation.current += 1;
    };
  }, [online, load]);
  return { requests, setRequests, error, setError, load };
}

export function ApprovalInbox({ online }: { online: boolean }) {
  const session = useIdentitySession();
  return session ? (
    <ConnectedInbox key={session.principalId} online={online} />
  ) : (
    <ConnectIdentityNote online={online} what="approval requests" />
  );
}

function useConnectedInbox(online: boolean) {
  const inbox = useInbox(online);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [sent, setSent] = useState<AccessRequest | null>(null);
  async function showAddress() {
    try {
      setAddress(await getInboxRef());
    } catch {
      inbox.setError("Cannot read your inbox address; reconnect and retry.");
    }
  }
  async function refreshSent() {
    if (!sent) return;
    try {
      setSent(await getAccessRequest(sent.authReqId));
    } catch {
      inbox.setError("Cannot refresh the sent request; reconnect and retry.");
    }
  }
  return {
    inbox,
    creating,
    setCreating,
    selected,
    setSelected,
    address,
    sent,
    setSent,
    showAddress,
    refreshSent,
  };
}

function ConnectedInbox({ online }: { online: boolean }) {
  const state = useConnectedInbox(online);
  const { inbox, creating, setCreating, address, sent, setSent, refreshSent } =
    state;
  return (
    <section className="panel">
      <InboxHeader online={online} state={state} />
      <div className="panel__body">
        {address ? (
          <output className="note">
            <code>{address}</code>
          </output>
        ) : null}
        {inbox.error ? (
          <p className="note note--err" role="alert">
            {inbox.error}
          </p>
        ) : null}
        {creating ? (
          <RequestForm
            online={online}
            onCancel={() => setCreating(false)}
            onCreated={(row) => {
              setSent(row);
              setCreating(false);
              void inbox.load();
            }}
          />
        ) : null}
        {sent ? (
          <SentRequest
            key={sent.authReqId}
            request={sent}
            online={online}
            onRefresh={() => void refreshSent()}
          />
        ) : null}
        <InboxRows online={online} state={state} />
      </div>
    </section>
  );
}

function InboxHeader({
  online,
  state,
}: { online: boolean; state: ReturnType<typeof useConnectedInbox> }) {
  const { inbox, setCreating, showAddress } = state;
  return (
    <div className="panel__head">
      <h2>Approval inbox</h2>
      <div className="actions">
        <button
          type="button"
          className="icon-btn"
          title="Reload approval inbox"
          aria-label="Reload approval inbox"
          disabled={!online}
          onClick={() => void inbox.load()}
        >
          <IconRefresh />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Request access"
          aria-label="Request access"
          disabled={!online}
          onClick={() => setCreating(true)}
        >
          <IconPlus />
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={!online}
          onClick={() => void showAddress()}
        >
          My inbox address
        </button>
      </div>
    </div>
  );
}

function InboxRows({
  online,
  state,
}: { online: boolean; state: ReturnType<typeof useConnectedInbox> }) {
  const { inbox, selected, setSelected } = state;
  return (
    <>
      {inbox.requests === null && !inbox.error ? (
        <output>{online ? "Loading approvals…" : "Offline."}</output>
      ) : null}
      {inbox.requests?.length === 0 ? (
        <p className="hint">
          No requests yet; share your inbox address or request access.
        </p>
      ) : null}
      <ul className="access-requests">
        {inbox.requests?.map((row) => (
          <li className="access-request" key={row.authReqId}>
            <div className="access-request__top">
              <h3>{row.bindingMessage}</h3>
              <span className="chip">{row.status}</span>
              {row.status === "pending" ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  aria-expanded={selected === row.authReqId}
                  onClick={() =>
                    setSelected(
                      selected === row.authReqId ? null : row.authReqId,
                    )
                  }
                >
                  Review request
                </button>
              ) : null}
            </div>
            {selected === row.authReqId && row.status === "pending" ? (
              <ApprovalReview
                key={row.authReqId}
                request={row}
                online={online}
                onDecided={(result) => {
                  inbox.setRequests(
                    (rows) =>
                      rows?.map((item) =>
                        item.authReqId === result.authReqId ? result : item,
                      ) ?? [],
                  );
                  setSelected(null);
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}
