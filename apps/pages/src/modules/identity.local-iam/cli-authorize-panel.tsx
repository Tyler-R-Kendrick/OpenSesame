import { localNetworkFetch } from "@opensesame/app-core/lib/local-network-fetch.js";
import { useEffect, useState } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconX } from "../../components/Icons.js";
import { CliAuthorizeApproveFlow } from "./cli-authorize-approve-flow.js";
import {
  type CliAuthorizeRow,
  cliAuthorizeAuthHeaders,
  daemonOrigin,
  parseFirstPending,
  postCliAuthorizeRespond,
} from "./cli-authorize-session.js";
import { cliAuthorizeUi } from "./cli-authorize-ui.js";

const ui = cliAuthorizeUi;

export function CliAuthorizePanel() {
  const [row, setRow] = useState<CliAuthorizeRow | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    void (async () => {
      const origin = daemonOrigin();
      const headers = cliAuthorizeAuthHeaders();
      if (!origin || !headers) return setRow(null);
      const res = await localNetworkFetch(
        `${origin}/v1/cli/app-integration/pending`,
        {
          method: "GET",
          credentials: "omit",
          cache: "no-store",
          headers,
        },
      );
      if (!res.ok) return setRow(null);
      setRow(parseFirstPending(await res.json()));
    })();
  }, []);

  async function respond(
    decision: "approve" | "deny",
    humanProof?: string,
  ): Promise<boolean> {
    if (!row || busy) return false;
    setBusy(true);
    const ok = await postCliAuthorizeRespond(row, decision, humanProof);
    setBusy(false);
    if (ok) {
      setRow(null);
      setApproving(false);
      return true;
    }
    return false;
  }

  function finishApprove() {
    setApproving(false);
  }

  if (approving && row) {
    return (
      <CliAuthorizeApproveFlow
        row={row}
        busy={busy}
        onBusyChange={setBusy}
        onDone={finishApprove}
        onRespond={respond}
      />
    );
  }

  return (
    <section className="panel" aria-label={ui.sheetTitle}>
      <div className="panel__head">
        <h1>{ui.sheetTitle}</h1>
      </div>
      <div className="panel__body">
        {row === undefined ? <output>Reading CLI request…</output> : null}
        {row === null ? <p>No CLI request is waiting.</p> : null}
        {row ? (
          <>
            <p>{ui.sheetLead}</p>
            <p>
              <code className="identity-ref">{row[2]}</code>
            </p>
          </>
        ) : null}
        {row ? (
          <FormCommit
            label={ui.allowKey}
            disabled={busy}
            onClick={() => setApproving(true)}
          >
            <IconKey
              label={ui.denyKey}
              disabled={busy}
              onClick={() => void respond("deny")}
            >
              <IconX size={16} />
            </IconKey>
          </FormCommit>
        ) : null}
      </div>
    </section>
  );
}
