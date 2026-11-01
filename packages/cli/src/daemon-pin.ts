import { readFile } from "node:fs/promises";
import { cliAppIntegrationPolicy } from "@opensesame/app-core/lib/cli-app-integration/index.js";
import { ephemeralTerminalCorrelationId } from "@opensesame/app-core/lib/cli-app-integration/terminal-session.js";
import {
  type BoundaryValue,
  asBufferSource,
  isJsonObject,
  readString,
} from "@opensesame/os-domain";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const DAEMON_PIN_PUBLIC_KEY_ENV =
  "OPENSESAME_CLI_APP_INTEGRATION_DAEMON_PIN_PUBLIC_KEY_SPKI_B64";
const DAEMON_PIN_PUBLIC_KEY_FILE_ENV =
  "OPENSESAME_CLI_APP_INTEGRATION_DAEMON_PIN_PUBLIC_KEY_FILE";

/** Remote daemon CLI app-integration requires invite + device flow (not wired yet). */
export function isLoopbackDaemonBase(base: string): boolean {
  try {
    const url = new URL(base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function healthLooksLikeDaemon(base: string): Promise<boolean> {
  const response = await fetch(`${base}/health`, {
    method: "GET",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return false;
  const body: BoundaryValue = await response.json();
  if (!isJsonObject(body)) return false;
  return readString(body.status) === "ok";
}

/**
 * Real daemon ensure never returns `approved` on a cold probe; journey fakes that
 * auto-approve are rejected here.
 */
async function ensureProbeRejectsInstantApproval(
  base: string,
): Promise<boolean> {
  const path = cliAppIntegrationPolicy.daemonPaths.ensure;
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(8_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      terminalSessionId: await ephemeralTerminalCorrelationId(),
      verb: cliAppIntegrationPolicy.daemonPinProbeVerb,
    }),
  });
  if (!response.ok) return false;
  const body: BoundaryValue = await response.json();
  if (!isJsonObject(body)) return false;
  const status = readString(body.status);
  if (status === "approved") return false;
  return (
    status === "pending" ||
    status === "denied" ||
    status === "expired" ||
    status === "wrongSession"
  );
}

function b64urlDecode(value: string): Uint8Array | null {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const pad = (4 - (padded.length % 4)) % 4;
  try {
    const binary = atob(padded + "=".repeat(pad));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

async function readOperatorDaemonPinPublicKeySpkiB64(): Promise<string | null> {
  const inline = process.env[DAEMON_PIN_PUBLIC_KEY_ENV]?.trim();
  if (inline) return inline;
  const path = process.env[DAEMON_PIN_PUBLIC_KEY_FILE_ENV]?.trim();
  if (!path) return null;
  try {
    const text = (await readFile(path, "utf8")).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function verifyDaemonAttestSignature(
  base: string,
  publicKeySpkiB64: string,
): Promise<boolean> {
  const attestPath =
    cliAppIntegrationPolicy.daemonPaths.daemonAttest ??
    "/v1/cli/app-integration/daemon-attest";
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  let nonce = "";
  for (const byte of nonceBytes) {
    nonce += byte.toString(16).padStart(2, "0");
  }
  const response = await fetch(`${base}${attestPath}`, {
    method: "POST",
    signal: AbortSignal.timeout(8_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
  if (!response.ok) return false;
  const body: BoundaryValue = await response.json();
  if (!isJsonObject(body)) return false;
  const signatureB64 = readString(body.signatureB64);
  if (!signatureB64) return false;
  const spki = b64urlDecode(publicKeySpkiB64);
  const sig = b64urlDecode(signatureB64);
  if (!spki || !sig) return false;
  const key = await crypto.subtle.importKey(
    "spki",
    asBufferSource(spki),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const label = new TextEncoder().encode("opensesame-cli-app-daemon-attest.v1");
  const message = new Uint8Array(label.byteLength + 1 + nonce.length);
  message.set(label, 0);
  message[label.byteLength] = 0;
  message.set(new TextEncoder().encode(nonce), label.byteLength + 1);
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    asBufferSource(sig),
    message,
  );
}

/** Pin loopback `OPENSESAME_DAEMON_API` to an OpenSesame daemon before trusting ensure. */
export async function verifyLocalDaemonForCliAppIntegration(
  base: string,
): Promise<boolean> {
  if (!isLoopbackDaemonBase(base)) return false;
  try {
    if (!(await healthLooksLikeDaemon(base))) return false;
    if (!(await ensureProbeRejectsInstantApproval(base))) return false;
    const operatorKey = await readOperatorDaemonPinPublicKeySpkiB64();
    if (!operatorKey) return false;
    return await verifyDaemonAttestSignature(base, operatorKey);
  } catch {
    return false;
  }
}
