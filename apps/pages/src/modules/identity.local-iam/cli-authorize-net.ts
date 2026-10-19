import { localNetworkFetch } from "@opensesame/app-core/lib/local-network-fetch.js";
import type { CliAuthorizeRow } from "./cli-authorize-mint-proof.js";

type CliRespondBody = Readonly<{
  requestId: string;
  terminalSessionId: string;
  decision: "approve" | "deny";
  respondNonce: string;
  humanProof?: string;
}>;

export type CliRespondResult = Readonly<{
  ok: boolean;
  status: string;
}>;

export async function postCliRespond(
  origin: string,
  headers: Record<string, string>,
  row: CliAuthorizeRow,
  decision: "approve" | "deny",
  humanProof?: string,
): Promise<CliRespondResult> {
  const base: CliRespondBody = {
    requestId: row[0],
    terminalSessionId: row[1],
    decision,
    respondNonce: row[3],
  };
  const body: CliRespondBody =
    decision === "approve" && humanProof ? { ...base, humanProof } : base;
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
  let status = "approval_unreadable";
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") {
      const record = parsed as { status?: unknown; error?: unknown };
      if (typeof record.status === "string" && record.status.length > 0) {
        status = record.status;
      } else if (typeof record.error === "string" && record.error.length > 0) {
        status = record.error;
      }
    }
  } catch {
    status = res.ok ? "approval_unreadable" : "approval_failed";
  }
  const ok = res.ok && (status === "approved" || status === "denied");
  return { ok, status };
}
