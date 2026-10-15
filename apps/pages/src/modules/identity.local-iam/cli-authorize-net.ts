import { localNetworkFetch } from "@opensesame/app-core/lib/local-network-fetch.js";
import type { CliAuthorizeRow } from "./cli-authorize-mint-proof.js";

type CliRespondBody = Readonly<{
  requestId: string;
  terminalSessionId: string;
  decision: "approve" | "deny";
  respondNonce: string;
  humanProof?: string;
}>;

export async function postCliRespond(
  origin: string,
  headers: Record<string, string>,
  row: CliAuthorizeRow,
  decision: "approve" | "deny",
  humanProof?: string,
): Promise<boolean> {
  const base: CliRespondBody = {
    requestId: row[0],
    terminalSessionId: row[1],
    decision,
    respondNonce: row[3],
  };
  const requestBody: CliRespondBody =
    decision === "approve" && humanProof ? { ...base, humanProof } : base;
  const res = await localNetworkFetch(
    `${origin}/v1/cli/app-integration/respond`,
    {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    },
  );
  if (!res.ok) return false;
  const responseBody = (await res.json()) as { status?: string };
  return (
    responseBody.status === "approved" || responseBody.status === "denied"
  );
}
