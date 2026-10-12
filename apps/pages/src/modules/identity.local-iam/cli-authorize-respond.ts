import { localNetworkFetch } from "@opensesame/app-core/lib/local-network-fetch.js";
import {
  type CliAuthorizeRow,
  cliAuthorizeAuthHeaders,
  daemonOrigin,
} from "./cli-authorize-session.js";

export async function postCliAuthorizeRespond(
  row: CliAuthorizeRow,
  decision: "approve" | "deny",
  humanProof?: string,
): Promise<boolean> {
  const origin = daemonOrigin();
  const headers = cliAuthorizeAuthHeaders();
  if (!origin || !headers) return false;
  const body: Record<string, string> = {
    requestId: row[0],
    terminalSessionId: row[1],
    decision,
    respondNonce: row[3],
  };
  if (decision === "approve" && humanProof) body.humanProof = humanProof;
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
  return res.ok;
}
