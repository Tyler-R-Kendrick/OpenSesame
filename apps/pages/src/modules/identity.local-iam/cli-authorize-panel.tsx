import { readCliAppIntegrationBearer } from "@opensesame/app-core/lib/cli-app-integration/bearer-session.js";
import { localNetworkFetch } from "@opensesame/app-core/lib/local-network-fetch.js";
import { loadSettings } from "@opensesame/app-core/lib/settings.js";
import {
  type BoundaryValue,
  isJsonObject,
  readString,
} from "@opensesame/os-domain";
import { useEffect, useState } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconX } from "../../components/Icons.js";

function daemonOrigin(): string | null {
  const raw = loadSettings().daemonApi.trim() || "http://127.0.0.1:18790";
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`).origin.replace(
      /\/$/,
      "",
    );
  } catch {
    return null;
  }
}

function pageOrigin(): string | null {
  try {
    return window.location.origin;
  } catch {
    return null;
  }
}

type Row = readonly [
  requestId: string,
  terminalSessionId: string,
  verb: string,
  respondNonce: string,
];

function parseFirst(body: BoundaryValue): Row | null {
  if (!isJsonObject(body) || !Array.isArray(body.pending)) return null;
  const entry = body.pending[0];
  if (!isJsonObject(entry)) return null;
  const requestId = readString(entry.requestId);
  const terminalSessionId = readString(entry.terminalSessionId);
  const verb = readString(entry.verb);
  const respondNonce = readString(entry.respondNonce);
  if (!requestId || !terminalSessionId || !verb || !respondNonce) return null;
  return [requestId, terminalSessionId, verb, respondNonce];
}

function authHeaders(): Record<string, string> | null {
  const token = readCliAppIntegrationBearer();
  const origin = pageOrigin();
  if (!token || !origin) return null;
  return {
    authorization: `Bearer ${token}`,
    Origin: origin,
  };
}

export function CliAuthorizePanel() {
  const [row, setRow] = useState<Row | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void (async () => {
      const origin = daemonOrigin();
      const headers = authHeaders();
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
      setRow(parseFirst(await res.json()));
    })();
  }, []);
  async function decide(decision: "approve" | "deny") {
    if (!row || busy) return;
    setBusy(true);
    const origin = daemonOrigin();
    const headers = authHeaders();
    if (!origin || !headers) return setBusy(false);
    const body: Record<string, string> = {
      requestId: row[0],
      terminalSessionId: row[1],
      decision,
      respondNonce: row[3],
    };
    if (decision === "approve") {
      body.humanProof = "pending-ui-human-proof-placeholder";
    }
    const res = await localNetworkFetch(
      `${origin}/v1/cli/app-integration/respond`,
      {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    setBusy(false);
    if (res.ok) setRow(null);
  }
  return (
    <section className="panel" aria-label="Authorize CLI">
      <div className="panel__head">
        <h1>Authorize CLI</h1>
      </div>
      <div className="panel__body">
        {row === undefined ? <output>Reading CLI request…</output> : null}
        {row === null ? <p>No CLI request is waiting.</p> : null}
        {row ? (
          <p>
            <code className="identity-ref">{row[2]}</code>
          </p>
        ) : null}
        {row ? (
          <FormCommit
            label="Authorize"
            disabled={busy}
            onClick={() => void decide("approve")}
          >
            <IconKey
              label="Deny"
              disabled={busy}
              onClick={() => void decide("deny")}
            >
              <IconX size={16} />
            </IconKey>
          </FormCommit>
        ) : null}
      </div>
    </section>
  );
}
