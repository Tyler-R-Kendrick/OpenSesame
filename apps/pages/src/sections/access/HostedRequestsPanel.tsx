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

function Rows({ inbox }: { inbox: Extract<HostedInbox, { kind: "rows" }> }) {
  if (inbox.rows.length === 0) return null;
  return (
    <ul className="access-local-records">
      {inbox.rows.map((row) => (
        <li key={row.id}>
          <strong>{row.bindingMessage}</strong>
          {row.details.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p className="hint">
            {row.summary} ·{" "}
            <time dateTime={row.expiresAt}>
              {new Date(row.expiresAt).toLocaleTimeString()}
            </time>
          </p>
          <p>
            <code className="access-ref" title={row.requestDigest}>
              {row.digestPrefix}
            </code>
          </p>
          <Link
            to={row.reviewPath}
            className="icon-btn icon-btn--sm"
            aria-label={APPROVAL_LABELS.open}
            title={APPROVAL_LABELS.open}
          >
            <IconArrowRight size={16} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function HostedRequestsPanel() {
  const online = useOnline();
  const { connect, connecting } = useConnect();
  const { inbox, busy, load } = useHostedInbox();
  const count = inbox?.kind === "rows" ? inbox.rows.length : null;
  return (
    <section
      className="panel"
      id="hosted-requests"
      aria-label={APPROVAL_LABELS.inbox}
    >
      <div className="panel__head">
        <h2>
          {APPROVAL_LABELS.inbox}
          {count !== null ? ` · ${count}` : null}
          {inbox?.kind === "signin" || inbox?.kind === "failed" ? (
            <>
              {" "}
              <StatusMark
                tone={inbox.kind === "signin" ? "warn" : "err"}
                label={inbox.words}
              />
            </>
          ) : null}
        </h2>
        <div className="actions">
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
        </div>
      </div>
      {inbox?.kind === "rows" ? (
        <div className="panel__body">
          <Rows inbox={inbox} />
        </div>
      ) : null}
    </section>
  );
}
