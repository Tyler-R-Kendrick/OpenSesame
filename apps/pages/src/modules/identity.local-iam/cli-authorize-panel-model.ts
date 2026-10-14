import { readCliAppIntegrationBearer } from "@opensesame/app-core/lib/cli-app-integration/bearer-session.js";
import { localNetworkFetch } from "@opensesame/app-core/lib/local-network-fetch.js";
import { loadSettings } from "@opensesame/app-core/lib/settings.js";
import type { VaultHeader } from "@opensesame/vault-core";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import type { CliAuthorizeRow } from "./cli-authorize-mint-proof.js";
import { postCliRespond } from "./cli-authorize-net.js";
import {
  runCliAuthorizePasskeyApprove,
  runCliAuthorizePinApprove,
} from "./cli-authorize-proof-run.js";

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

const LOAD_BLOCKED =
  "CLI approval is blocked here. Open OpenSesame on your own site.";
const LOAD_UNREADABLE = "Couldn't check for CLI requests.";

/** The deployment fence in `localNetworkFetch` refuses with a SecurityError. */
function isDeploymentBlocked(error: DOMException | null): boolean {
  return error?.name === "SecurityError";
}

function blockedCopy(error: DOMException | null, fallback: string): string {
  return isDeploymentBlocked(error) ? LOAD_BLOCKED : fallback;
}

function wireString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function parseFirst(body: unknown): CliAuthorizeRow | null {
  if (!body || typeof body !== "object") return null;
  const pending = (body as Record<string, unknown>).pending;
  if (!Array.isArray(pending)) return null;
  const entry = pending[0];
  if (!entry || typeof entry !== "object") return null;
  const row = entry as Record<string, unknown>;
  const requestId = wireString(row, "requestId");
  const terminalSessionId = wireString(row, "terminalSessionId");
  const verb = wireString(row, "verb");
  const respondNonce = wireString(row, "respondNonce");
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

type PendingLoad = {
  row: CliAuthorizeRow | null;
  loadError: string | null;
};

async function loadPending(): Promise<PendingLoad> {
  const origin = daemonOrigin();
  const headers = authHeaders();
  if (!origin || !headers) return { row: null, loadError: LOAD_UNREADABLE };
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
    if (!res.ok) return { row: null, loadError: LOAD_UNREADABLE };
    return { row: parseFirst(await res.json()), loadError: null };
  } catch (error) {
    return {
      row: null,
      loadError: blockedCopy(
        error instanceof DOMException ? error : null,
        LOAD_UNREADABLE,
      ),
    };
  }
}

export function useCliAuthorizePanel() {
  const [row, setRow] = useState<CliAuthorizeRow | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [mark, setMark] = useState<string | null>(null);
  const [header, setHeader] = useState<VaultHeader | null>(null);

  useEffect(() => {
    void (async () => {
      const pending = await loadPending();
      setLoadError(pending.loadError);
      setRow(pending.row);
    })();
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
      const ok = await postCliRespond(
        origin,
        headers,
        row,
        decision,
        humanProof,
      );
      setBusy(false);
      if (ok) setRow(null);
      else setMark("That did not work.");
    } catch (error) {
      setBusy(false);
      setMark(
        blockedCopy(
          error instanceof DOMException ? error : null,
          "That did not work.",
        ),
      );
    }
  }

  const proofInput = {
    row,
    busy,
    setBusy,
    setMark,
    setHeader,
    setPinOpen,
    finish,
  };

  return {
    row,
    loadError,
    busy,
    pinOpen,
    pin,
    mark,
    setPin,
    onPasskey: () => {
      if (row) void runCliAuthorizePasskeyApprove({ ...proofInput, row });
    },
    onPin: (event: FormEvent) => {
      if (row)
        void runCliAuthorizePinApprove({
          ...proofInput,
          row,
          pin,
          header,
          event,
        });
    },
    onDeny: () => void finish("deny"),
  };
}
