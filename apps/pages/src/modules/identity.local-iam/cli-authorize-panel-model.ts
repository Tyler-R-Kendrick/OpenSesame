import { readCliAppIntegrationBearer } from "@opensesame/app-core/lib/cli-app-integration/bearer-session.js";
import type { CliAppPasskeyReady } from "@opensesame/app-core/lib/cli-app-integration/webauthn-credential.js";
import { localNetworkFetch } from "@opensesame/app-core/lib/local-network-fetch.js";
import { loadSettings } from "@opensesame/app-core/lib/settings.js";
import { useEffect, useState } from "react";
import { z } from "zod";
import {
  CLI_AUTHORIZE_LOAD_BLOCKED,
  CLI_AUTHORIZE_LOAD_UNREADABLE,
  CLI_AUTHORIZE_RESPOND_UNREACHABLE,
  cliAuthorizeRespondMessage,
} from "./cli-authorize-messages.js";
import type { CliAuthorizeRow } from "./cli-authorize-mint-proof.js";
import { postCliRespond } from "./cli-authorize-net.js";
import { runCliAuthorizePasskeyApprove } from "./cli-authorize-proof-run.js";

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

export { CLI_AUTHORIZE_LOAD_BLOCKED, CLI_AUTHORIZE_LOAD_UNREADABLE };

const PENDING_POLL_MS = 5000;

/** The deployment fence in `localNetworkFetch` refuses with a SecurityError. */
function isDeploymentBlocked(error: DOMException | null): boolean {
  return error?.name === "SecurityError";
}

function blockedCopy(error: DOMException | null, fallback: string): string {
  return isDeploymentBlocked(error) ? CLI_AUTHORIZE_LOAD_BLOCKED : fallback;
}

const cliAuthorizePendingBodySchema = z.object({
  daemonIntegrationId: z.string().optional(),
  pending: z.array(
    z.object({
      requestId: z.string(),
      terminalSessionId: z.string(),
      verb: z.string(),
      respondNonce: z.string(),
      argvHash: z.string().optional(),
      peerPid: z.number().optional(),
      peerStartTime: z.number().optional(),
      approvable: z.boolean().optional(),
    }),
  ),
});

function authHeaders(): Record<string, string> | null {
  const token = readCliAppIntegrationBearer();
  const origin = pageOrigin();
  if (!token || !origin) return null;
  return {
    authorization: `Bearer ${token}`,
    Origin: origin,
  };
}

type PendingLoad = {
  row: CliAuthorizeRow | null;
  loadError: string | null;
};

async function loadPending(): Promise<PendingLoad> {
  const origin = daemonOrigin();
  const headers = authHeaders();
  if (!origin || !headers)
    return { row: null, loadError: CLI_AUTHORIZE_LOAD_UNREADABLE };
  try {
    const res = await localNetworkFetch(
      `${origin}/v1/cli/app-integration/pending`,
      {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        headers,
      },
    );
    if (!res.ok) return { row: null, loadError: CLI_AUTHORIZE_LOAD_UNREADABLE };
    const body = cliAuthorizePendingBodySchema.safeParse(await res.json());
    if (!body.success) return { row: null, loadError: null };
    const entry = body.data.pending[0];
    if (!entry) return { row: null, loadError: null };
    const row: CliAuthorizeRow = [
      entry.requestId,
      entry.terminalSessionId,
      entry.verb,
      entry.respondNonce,
      body.data.daemonIntegrationId ?? "ephemeral-no-attest",
      entry.argvHash ?? "00",
      entry.peerPid ?? 0,
      entry.peerStartTime ?? 0,
    ];
    return { row, loadError: null };
  } catch (error) {
    return {
      row: null,
      loadError: blockedCopy(
        error instanceof DOMException ? error : null,
        CLI_AUTHORIZE_LOAD_UNREADABLE,
      ),
    };
  }
}

export function useCliAuthorizePanel() {
  const [row, setRow] = useState<CliAuthorizeRow | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mark, setMark] = useState<string | null>(null);
  const [passkeyReady, setPasskeyReady] =
    useState<CliAppPasskeyReady>("loading");

  useEffect(() => {
    let cancelled = false;
    void import(
      "@opensesame/app-core/lib/cli-app-integration/webauthn-credential.js"
    )
      .then((mod) => mod.loadCliAppPasskeyReady())
      .then((ready) => {
        if (!cancelled) setPasskeyReady(ready);
      })
      .catch(() => {
        if (!cancelled) setPasskeyReady("unsupported");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const pending = await loadPending();
      if (cancelled) return;
      setLoadError(pending.loadError);
      setRow(pending.row);
    };
    void refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, PENDING_POLL_MS);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
    };
  }, []);

  async function finish(decision: "approve" | "deny", humanProof?: string) {
    if (!row || busy) return;
    setBusy(true);
    const origin = daemonOrigin();
    const headers = authHeaders();
    if (!origin || !headers) {
      setBusy(false);
      return;
    }
    try {
      const result = await postCliRespond(
        origin,
        headers,
        row,
        decision,
        humanProof,
      );
      setBusy(false);
      if (result.ok) {
        setRow(null);
        setMark(null);
      } else setMark(cliAuthorizeRespondMessage(result.status));
    } catch (error) {
      setBusy(false);
      setMark(
        blockedCopy(
          error instanceof DOMException ? error : null,
          CLI_AUTHORIZE_RESPOND_UNREACHABLE,
        ),
      );
    }
  }

  return {
    row,
    loadError,
    busy,
    mark,
    passkeyReady,
    onPasskey: () => {
      if (row)
        void runCliAuthorizePasskeyApprove({
          row,
          busy,
          setBusy,
          setMark,
          finish,
        });
    },
    onDeny: () => void finish("deny"),
  };
}
