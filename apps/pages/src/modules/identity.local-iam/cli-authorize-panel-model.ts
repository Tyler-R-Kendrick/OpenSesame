import { readCliAppIntegrationBearer } from "@opensesame/app-core/lib/cli-app-integration/bearer-session.js";
import { localNetworkFetch } from "@opensesame/app-core/lib/local-network-fetch.js";
import { loadSettings } from "@opensesame/app-core/lib/settings.js";
import {
  type BoundaryValue,
  isJsonObject,
  readString,
} from "@opensesame/os-domain";
import type { VaultHeader } from "@opensesame/vault-core";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { postCliRespond } from "./cli-authorize-net.js";
import {
  CLI_AUTHORIZE_PROOF_OFFLINE,
  type CliAuthorizeRow,
} from "./cli-authorize-net.js";

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

function parseFirst(body: BoundaryValue): CliAuthorizeRow | null {
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

async function loadProofRun() {
  try {
    return await import("./cli-authorize-proof-run.js");
  } catch {
    return null;
  }
}

export function useCliAuthorizePanel() {
  const [row, setRow] = useState<CliAuthorizeRow | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [mark, setMark] = useState<string | null>(null);
  const [header, setHeader] = useState<VaultHeader | null>(null);

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

  useEffect(() => {
    if (!row) return;
    void loadProofRun().then((run) => {
      if (!run) setMark(CLI_AUTHORIZE_PROOF_OFFLINE);
    });
  }, [row]);

  async function finish(decision: "approve" | "deny", humanProof?: string) {
    if (!row || busy) return;
    setBusy(true);
    const origin = daemonOrigin();
    const headers = authHeaders();
    if (!origin || !headers) {
      setBusy(false);
      return;
    }
    const ok = await postCliRespond(origin, headers, row, decision, humanProof);
    setBusy(false);
    if (ok) setRow(null);
    else setMark("That did not work.");
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
    busy,
    pinOpen,
    pin,
    mark,
    setPin,
    onPasskey: () => {
      if (!row) return;
      void (async () => {
        const run = await loadProofRun();
        if (!run) {
          setMark(CLI_AUTHORIZE_PROOF_OFFLINE);
          return;
        }
        await run.runCliAuthorizePasskeyApprove({ ...proofInput, row });
      })();
    },
    onPin: (event: FormEvent) => {
      if (!row) return;
      void (async () => {
        const run = await loadProofRun();
        if (!run) {
          setMark(CLI_AUTHORIZE_PROOF_OFFLINE);
          return;
        }
        await run.runCliAuthorizePinApprove({
          ...proofInput,
          row,
          pin,
          header,
          event,
        });
      })();
    },
    onDeny: () => void finish("deny"),
  };
}
