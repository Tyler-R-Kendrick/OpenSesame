import { initialDraftState } from "@opensesame/app-core/lib/connect-draft.js";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { configureLinearConnector } from "@opensesame/app-core/lib/linear-connectors.js";
import { linearApiSeams } from "@opensesame/app-core/lib/linear-http.js";
import {
  linearPublicRecord,
  updateLinearRecord,
} from "@opensesame/app-core/lib/linear-store.js";
import type { BoundaryValue } from "@opensesame/os-domain";

export const linearUiAccount = {
  viewer: { id: "person-1", name: "Person", email: "person@example.test" },
  organization: {
    id: "workspace-1",
    name: "Verified workspace",
    urlKey: "verified-workspace",
  },
  teams: { nodes: [{ id: "team-1", name: "Engineering", key: "ENG" }] },
};

export function linearUiResponse(data: BoundaryValue): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Use the actual provider verification and sealed store, rather than replacing readers. */
export async function createLinearUiConnection() {
  const plan = connectPlan("linear");
  if (!plan) throw new Error("Linear plan required");
  linearApiSeams.fetch = async () => linearUiResponse(linearUiAccount);
  const draft = initialDraftState(plan, "api-key");
  const connection = await configureLinearConnector(
    { ...draft, name: "Verified Linear", key: "private-api-key" },
    {
      mode: "byo",
      workspace: "",
      appScopes: ["read", "issues:create"],
      userScopes: [],
      webhookResourceTypes: [],
      icon: "",
    },
  );
  // A second actor fixture keeps actor selection tied to real sealed grants.
  await updateLinearRecord(connection.connectionId, async (record, runtime) => {
    const expiresAt = Date.now() + 86_400_000;
    const user = {
      accountLabel: "Person",
      workspaceId: "workspace-1",
      workspaceName: "Verified workspace",
      workspaceKey: "verified-workspace",
      grantedScopes: ["read"],
      expiresAt,
      kind: "oauth" as const,
    };
    return linearPublicRecord(
      {
        ...record,
        secrets: {
          ...record.secrets,
          linear_user_grant: JSON.stringify({
            kind: "oauth",
            accessToken: "private-user-token",
            scopes: ["read"],
            expiresAt,
          }),
        },
      },
      { ...runtime, user },
    );
  });
  return connection.connectionId;
}

export async function installLinearUiWebhook(connectorId: string) {
  await updateLinearRecord(connectorId, async (record, runtime) =>
    linearPublicRecord(
      {
        ...record,
        secrets: {
          ...record.secrets,
          linear_webhook_secret: "private-signing-secret",
        },
      },
      {
        ...runtime,
        webhook: {
          id: "hook-1",
          url: "https://receiver.example.test/linear",
          resourceTypes: ["Issue"],
        },
      },
    ),
  );
}
