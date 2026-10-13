import { cliAppDaemonPaths } from "@opensesame/app-core/lib/cli-app-integration/daemon-paths.js";
import { localNetworkFetch } from "@opensesame/app-core/lib/local-network-fetch.js";
import type { CliAuthorizeRow } from "./cli-authorize-mint-proof.js";

export async function postCliRespond(
  origin: string,
  headers: Record<string, string>,
  row: CliAuthorizeRow,
  decision: "approve" | "deny",
  humanProof?: string,
): Promise<boolean> {
  const body: Record<string, string> = {
    requestId: row[0],
    terminalSessionId: row[1],
    decision,
    respondNonce: row[3],
  };
  if (decision === "approve" && humanProof) body.humanProof = humanProof;
  const res = await localNetworkFetch(
    `${origin}${cliAppDaemonPaths.respond}`,
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
