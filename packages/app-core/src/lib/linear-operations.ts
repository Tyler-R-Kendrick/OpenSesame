/** Typed, awaited operations against Linear, never the generic connector URL. */
import {
  LinearApiError,
  type LinearIssue,
  type LinearProject,
  createLinearIssue,
  listLinearIssues,
  listLinearProjects,
  readLinearIssue,
  readLinearProject,
  verifyLinearAccount,
} from "./linear-api.js";
import { linearCredential, markLinearReauth } from "./linear-credentials.js";
import {
  type LinearActor,
  readLinearConnector,
  requireLinearConnection,
} from "./linear-store.js";
export type LinearOperation =
  | "issue.read"
  | "issue.create"
  | "project.read"
  | "issues.list"
  | "projects.list"
  | "teams.list";
export type LinearOperationInput = {
  id?: string;
  teamId?: string;
  title?: string;
  description?: string;
};
export type LinearOperationResult =
  | LinearIssue
  | LinearProject
  | LinearIssue[]
  | LinearProject[]
  | { id: string; name: string; key: string }[];
export async function invokeLinearConnector(
  id: string,
  operation: LinearOperation,
  input: LinearOperationInput = {},
  actor: LinearActor = "app",
): Promise<LinearOperationResult> {
  if (requireLinearConnection(id).status !== "active")
    throw new Error(
      "Finish Linear authorization and configuration before using this connector",
    );
  const identity = readLinearConnector(id)?.[actor];
  if (!identity) throw new Error(`Authorize the Linear ${actor} account first`);
  if (
    operation === "issue.create" &&
    identity.kind === "oauth" &&
    !identity.grantedScopes.some(
      (scope) => scope === "write" || scope === "issues:create",
    )
  )
    throw new Error(
      "Linear issue creation requires write or issues:create permission",
    );
  const credential = await linearCredential(id, actor);
  try {
    return await execute(credential, operation, input);
  } catch (error) {
    if (error instanceof LinearApiError && error.code === "authorization")
      await markLinearReauth(id, actor);
    throw error;
  }
}

async function execute(
  credential: import("./linear-api.js").LinearCredential,
  operation: LinearOperation,
  input: LinearOperationInput,
): Promise<LinearOperationResult> {
  switch (operation) {
    case "issues.list":
      return await listLinearIssues(credential);
    case "projects.list":
      return await listLinearProjects(credential);
    case "teams.list":
      return (await verifyLinearAccount(credential)).teams;
    case "issue.read":
      return await readLinearIssue(credential, input.id ?? "");
    case "project.read":
      return await readLinearProject(credential, input.id ?? "");
    case "issue.create": {
      const details: Parameters<typeof createLinearIssue>[1] = {
        teamId: input.teamId ?? "",
        title: input.title ?? "",
      };
      if (input.description !== undefined)
        details.description = input.description;
      return await createLinearIssue(credential, details);
    }
    default:
      throw new Error("Unsupported Linear operation");
  }
}
