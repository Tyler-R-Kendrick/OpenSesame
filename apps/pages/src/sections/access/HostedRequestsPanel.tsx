/**
 * Access › Requests' hosted rows (ADR 0046, ADR 0084; ADR 0140 plan step 9):
 * the authorization requests addressed to this Identity session, beside the
 * local ones — the old ceremonies `/inbox`. The rows are app-core's
 * (`listHostedRequests`, `hostedRequestRow`), and so are their words.
 *
 * A row decides nothing: it opens `/approve/<ref>`, where the whole request
 * is read and the decision is bound to its digest, verb and policy. Even a
 * row whose policy asks for nothing beyond a decision is reviewed there —
 * the list never approves with less than the review does.
 *
 * Drawn — and loaded — only where an Identity API is configured (ADR 0090,
 * `AccessSection`): the requests live there, and a deployment without one
 * has none to show.
 */

import { APPROVAL_LABELS } from "@opensesame/app-core/lib/approvals-route.js";
import {
  type HostedInbox,
  listHostedRequests,
} from "@opensesame/app-core/lib/approvals.js";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { useConnect, useIdentitySession } from "../../bindings/identity.js";
import { IconKey, ReloadKey } from "../../components/IconKey.js";
import { IconArrowRight, IconLogin } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useOnline } from "../../lib/use-online.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import {
  AccessDetail,
  AccessFact,
  AccessRecords,
  useAccessRecord,
} from "./AccessRecords.js";

export const hostedRequestsSeams = { list: () => listHostedRequests() };

type Loaded = HostedInbox | { kind: "failed"; words: string } | null;

function useHostedInbox() {
  const session = useIdentitySession();
  const [inbox, setInbox] = useState<Loaded>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      setInbox(await hostedRequestsSeams.list());
    } catch (error) {
      setInbox({
        kind: "failed",
        words: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a session arriving or leaving reloads
  useEffect(() => {
    void load();
  }, [session]);
  return { inbox, busy, load };
}

export function HostedRequestsPanel() {
  const online = useOnline();
  const { connect, connecting } = useConnect();
  const { inbox, busy, load } = useHostedInbox();
  const selection = useAccessRecord("hosted-requests", "requests");
  const rows = inbox?.kind === "rows" ? inbox.rows : [];
  const selected = rows.find((row) => row.id === selection.id);
  const panelRef = useGuideTarget<HTMLDivElement>("access.relay");
  return (
    <AccessRecords
      title={APPROVAL_LABELS.inbox}
      selection={selection}
      rows={rows.map((row) => ({
        id: row.id,
        label: row.bindingMessage,
        extension: "request",
        to: selection.path(row.id),
      }))}
      status={<div id="hosted-requests" ref={panelRef} />}
      commands={
        <>
          {inbox?.kind === "signin" || inbox?.kind === "failed" ? (
            <StatusMark
              tone={inbox.kind === "signin" ? "warn" : "err"}
              label={inbox.words}
            />
          ) : null}
          {inbox?.kind === "signin" ? (
            <IconKey
              small
              label="Connect"
              disabled={connecting || !online}
              onClick={() => void connect()}
            >
              <IconLogin size={15} />
            </IconKey>
          ) : null}
          <ReloadKey
            label="Reload requests for you"
            disabled={busy || !online}
            onReload={() => void load()}
          />
        </>
      }
    >
      <div>
        {selected ? (
          <AccessDetail
            title={selected.bindingMessage}
            kind="Request"
            actions={
              <Link
                to={selected.reviewPath}
                className="icon-btn icon-btn--sm"
                aria-label={APPROVAL_LABELS.open}
                title={APPROVAL_LABELS.open}
              >
                <IconArrowRight size={16} />
              </Link>
            }
          >
            {selected.details.map((line) => (
              <AccessFact key={line} label="Binding" value={line} />
            ))}
            <AccessFact label="Summary" value={selected.summary} />
            <AccessFact
              label="Expires"
              value={new Date(selected.expiresAt).toLocaleString()}
            />
            <AccessFact label="Digest" value={selected.requestDigest} />
          </AccessDetail>
        ) : null}
      </div>
    </AccessRecords>
  );
}
