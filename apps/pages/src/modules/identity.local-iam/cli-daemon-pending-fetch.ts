import { cliAppDaemonPaths } from "@opensesame/app-core/lib/cli-app-integration/daemon-paths.js";

export type CliDaemonPendingRow = Readonly<{
  requestId: string;
  terminalSessionId: string;
  verb: string;
  respondNonce: string;
}>;

function parseFirst(body: unknown): CliDaemonPendingRow | null {
  if (!body || typeof body !== "object") return null;
  const pending = (body as { pending?: unknown }).pending;
  if (!Array.isArray(pending) || pending.length === 0) return null;
  const entry = pending[0];
  if (!entry || typeof entry !== "object") return null;
  const requestId = (entry as { requestId?: unknown }).requestId;
  const terminalSessionId = (entry as { terminalSessionId?: unknown })
    .terminalSessionId;
  const verb = (entry as { verb?: unknown }).verb;
  const respondNonce = (entry as { respondNonce?: unknown }).respondNonce;
  if (
    typeof requestId !== "string" ||
    typeof terminalSessionId !== "string" ||
    typeof verb !== "string" ||
    typeof respondNonce !== "string"
  ) {
    return null;
  }
  return { requestId, terminalSessionId, verb, respondNonce };
}

export async function fetchDaemonCliPending(
  daemonOrigin: string,
  headers: Record<string, string>,
): Promise<CliDaemonPendingRow | null> {
  const res = await fetch(`${daemonOrigin}${cliAppDaemonPaths.pending}`, {
    method: "GET",
    credentials: "omit",
    cache: "no-store",
    headers,
  });
  if (!res.ok) return null;
  return parseFirst(await res.json());
}
