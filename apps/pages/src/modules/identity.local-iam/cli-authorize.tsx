import type { PendingRequest } from "@opensesame/app-core/lib/cli-app-integration/pending-request.js";
import { mayPairLocalAuthority } from "@opensesame/app-core/lib/deployment-profile.js";
import { localNetworkFetch } from "@opensesame/app-core/lib/local-network-fetch.js";
import { loadSettings } from "@opensesame/app-core/lib/settings.js";
import { listAvailableUnlockMethods } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import {
  type BoundaryValue,
  isJsonObject,
  readString,
} from "@opensesame/os-domain";
import { WrongPasswordError } from "@opensesame/vault-core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FieldShell } from "../../components/FieldShell.js";
import { useFailureNotice } from "../../components/use-failure-notice.js";
import { useVault } from "../../lib/vault/hooks.js";
import { useVaultStore } from "../../lib/vault/hooks.js";

const title = "Authorize CLI";

function daemonOrigin(): string | null {
  const raw = loadSettings().daemonApi.trim() || "http://127.0.0.1:18790";
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return url.origin.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function parsePending(body: BoundaryValue): readonly PendingRequest[] {
  if (!isJsonObject(body) || !Array.isArray(body.pending)) return [];
  const rows: PendingRequest[] = [];
  for (const entry of body.pending) {
    if (!isJsonObject(entry)) continue;
    const requestId = readString(entry.requestId);
    const terminalSessionId = readString(entry.terminalSessionId);
    const verb = readString(entry.verb);
    if (!requestId || !terminalSessionId || !verb) continue;
    const referenceRaw = readString(entry.reference);
    const reference =
      referenceRaw && referenceRaw.length > 0 ? referenceRaw : undefined;
    rows.push({
      requestId,
      terminalSessionId,
      verb,
      reference,
      createdAtMs: 0,
    });
  }
  return rows;
}

async function listPending(): Promise<readonly PendingRequest[]> {
  const origin = daemonOrigin();
  if (!origin) return [];
  const response = await localNetworkFetch(
    `${origin}/v1/cli/app-integration/pending`,
    { method: "GET", credentials: "omit", cache: "no-store" },
  );
  if (!response.ok) return [];
  const body: BoundaryValue = await response.json();
  return parsePending(body);
}

async function respond(
  requestId: string,
  terminalSessionId: string,
  decision: "approve" | "deny",
): Promise<boolean> {
  const origin = daemonOrigin();
  if (!origin) return false;
  const response = await localNetworkFetch(
    `${origin}/v1/cli/app-integration/respond`,
    {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, terminalSessionId, decision }),
    },
  );
  if (!response.ok) return false;
  const body: BoundaryValue = await response.json();
  if (
    !isJsonObject(body) ||
    body.status === undefined ||
    body.status === null
  ) {
    return false;
  }
  const status = readString(body.status);
  if (!status) return false;
  return status === decision || status === "approved";
}

function CliAuthorizeSheet({
  request,
  onClose,
  onSettled,
}: {
  request: PendingRequest;
  onClose: () => void;
  onSettled: () => void;
}) {
  const store = useVaultStore();
  const header = store.getSnapshot().header;
  const methods = header ? listAvailableUnlockMethods(header) : [];
  const canPasskey = methods.includes("passkey");
  const canPin = methods.includes("pin");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  useFailureNotice("cli-authorize", title, error);

  async function settleAfter(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      onSettled();
      onClose();
    } catch (failure) {
      const message =
        failure instanceof WrongPasswordError || failure instanceof Error
          ? failure.message
          : "Authorization was not completed.";
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  const ref = request.reference?.trim();
  const facts = [
    { key: "Session", value: request.terminalSessionId.slice(0, 12) },
    { key: "Command", value: request.verb },
    ...(ref ? [{ key: "Item", value: ref }] : []),
  ];

  return (
    <CeremonySheet
      title={title}
      mark={null}
      onClose={onClose}
      initialFocus={canPin && !canPasskey ? pinRef : undefined}
    >
      <CeremonyShell
        ok={!error}
        name={title}
        facts={facts}
        primary={{
          label: "Authorize",
          choice: true,
          onClick: () =>
            void settleAfter(async () => {
              if (store.getSnapshot().status !== "unlocked") {
                throw new Error("Unlock OpenSesame first.");
              }
              if (canPasskey) {
                const probe = await store.probePasskeyCeremony({});
                await store.unlockWithHeldPrf(probe.prfOutput);
              } else if (canPin) {
                await store.unlockWithPin(pin);
              } else {
                throw new Error(
                  "Enroll a passkey or PIN in Settings › Security.",
                );
              }
              if (
                !(await respond(
                  request.requestId,
                  request.terminalSessionId,
                  "approve",
                ))
              ) {
                throw new Error("CLI integration could not reach the daemon.");
              }
            }),
          busy,
          disabled: busy || !(canPasskey || (canPin && pin.length > 0)),
        }}
        secondary={{
          label: "Deny",
          choice: true,
          onClick: () =>
            void settleAfter(async () => {
              if (
                !(await respond(
                  request.requestId,
                  request.terminalSessionId,
                  "deny",
                ))
              ) {
                throw new Error("CLI integration could not reach the daemon.");
              }
            }),
          busy,
          disabled: busy,
        }}
      >
        {canPin && !canPasskey ? (
          <FieldShell
            inputRef={pinRef}
            label="Confirm with PIN"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder="PIN"
            value={pin}
            disabled={busy}
            onValueChange={setPin}
          />
        ) : null}
      </CeremonyShell>
    </CeremonySheet>
  );
}

/** Polls the daemon while the vault is unlocked and opens the authorize sheet. */
export function CliAuthorizeHost({ children }: { children?: ReactNode }) {
  const { status } = useVault();
  const [pending, setPending] = useState<PendingRequest | null>(null);

  useEffect(() => {
    if (status !== "unlocked" || !mayPairLocalAuthority()) {
      setPending(null);
      return;
    }
    let cancelled = false;
    const tick = () => {
      void listPending().then((rows) => {
        if (cancelled) return;
        setPending((current) => {
          if (rows.length === 0) return null;
          if (current) {
            const still = rows.find(
              (row) => row.requestId === current.requestId,
            );
            return still ?? rows[0] ?? null;
          }
          return rows[0] ?? null;
        });
      });
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [status]);

  return (
    <>
      {children}
      {pending ? (
        <CliAuthorizeSheet
          request={pending}
          onClose={() => setPending(null)}
          onSettled={() => setPending(null)}
        />
      ) : null}
    </>
  );
}
