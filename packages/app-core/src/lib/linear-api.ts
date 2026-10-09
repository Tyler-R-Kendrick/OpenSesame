/** Browser-compatible public PKCE and typed Linear GraphQL operations. */
import { z } from "zod";
import {
  LinearApiError,
  type LinearCredential,
  linearGraphql,
  linearInput,
  linearOutput,
  linearRequest,
} from "./linear-http.js";

export { LinearApiError, type LinearCredential };
export { linearApiSeams } from "./linear-http.js";
export {
  createLinearWebhook,
  deleteLinearWebhook,
  listLinearWebhooks,
} from "./linear-webhook-api.js";

export type LinearGrant = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
};

const Text = z.string().trim().min(1).max(256);
const LinearResourceUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "linear.app" &&
      !url.username &&
      !url.password
    );
  });
const Secret = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[!-~]+$/);
const TokenResponse = z.object({
  access_token: Secret,
  refresh_token: Secret.optional(),
  token_type: z.string().regex(/^Bearer$/i),
  expires_in: z.number().int().positive().max(31_536_000),
  scope: z.union([
    z
      .string()
      .max(2048)
      .transform((value) => value.split(/[\s,]+/)),
    z.array(Text).max(64),
  ]),
});

async function tokenRequest(form: URLSearchParams): Promise<LinearGrant> {
  const reply = await linearRequest("/oauth/token", {
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const token = linearOutput(TokenResponse, reply);
  const grant: LinearGrant = {
    accessToken: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    scopes: [...new Set(token.scope.filter(Boolean))],
  };
  if (token.refresh_token) grant.refreshToken = token.refresh_token;
  return grant;
}

const Client = z.object({ clientId: Text, clientSecret: Secret.optional() });
const CodeInput = Client.extend({
  code: Secret,
  verifier: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9._~-]+$/),
  redirectUri: z.string().url().max(2048),
});

export async function exchangeLinearCode(
  input: z.infer<typeof CodeInput>,
): Promise<LinearGrant> {
  const checked = linearInput(CodeInput, input);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: checked.clientId,
    code: checked.code,
    code_verifier: checked.verifier,
    redirect_uri: checked.redirectUri,
  });
  if (checked.clientSecret) form.set("client_secret", checked.clientSecret);
  return tokenRequest(form);
}

const RefreshInput = Client.extend({ refreshToken: Secret });

export async function refreshLinearToken(
  input: z.infer<typeof RefreshInput>,
): Promise<LinearGrant> {
  const checked = linearInput(RefreshInput, input);
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: checked.clientId,
    refresh_token: checked.refreshToken,
  });
  if (checked.clientSecret) form.set("client_secret", checked.clientSecret);
  return tokenRequest(form);
}

/** Personal API keys are removed locally; Linear exposes OAuth token revocation here. */
export async function revokeLinearToken(
  credential: LinearCredential,
  tokenTypeHint: "access_token" | "refresh_token" = "access_token",
): Promise<void> {
  if (credential.kind !== "oauth") throw new LinearApiError("input");
  const token = linearInput(Secret, credential.token);
  await linearRequest(
    "/oauth/revoke",
    {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token,
        token_type_hint: tokenTypeHint,
      }).toString(),
    },
    true,
  );
}

const Team = z.object({ id: Text, name: Text, key: Text });
const AccountSchema = z.object({
  viewer: z.object({ id: Text, name: Text, email: z.string().max(320) }),
  organization: z.object({ id: Text, name: Text, urlKey: Text }),
  teams: z.object({ nodes: z.array(Team).max(1000) }),
});
export type LinearAccount = {
  viewer: z.infer<typeof AccountSchema>["viewer"];
  organization: z.infer<typeof AccountSchema>["organization"];
  teams: z.infer<typeof Team>[];
};

export async function verifyLinearAccount(
  credential: LinearCredential,
): Promise<LinearAccount> {
  const account = await linearGraphql(
    credential,
    "query OpenSesameAccount { viewer { id name email } organization { id name urlKey } teams(first: 100) { nodes { id name key } } }",
    {},
    AccountSchema,
  );
  return { ...account, teams: account.teams.nodes };
}

const Issue = z.object({
  id: Text,
  identifier: Text,
  title: z.string().min(1).max(10_000),
  description: z.string().max(100_000).nullable(),
  url: LinearResourceUrl,
});
export type LinearIssue = z.infer<typeof Issue>;
const ISSUE_FIELDS = "id identifier title description url";

export async function readLinearIssue(
  credential: LinearCredential,
  id: string,
): Promise<LinearIssue> {
  const checked = linearInput(Text, id);
  const reply = await linearGraphql(
    credential,
    `query OpenSesameIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
    { id: checked },
    z.object({ issue: Issue }),
  );
  return reply.issue;
}

const CreateIssue = z.object({
  teamId: Text,
  title: z.string().trim().min(1).max(10_000),
  description: z.string().max(100_000).optional(),
});

export async function createLinearIssue(
  credential: LinearCredential,
  input: z.infer<typeof CreateIssue>,
): Promise<LinearIssue> {
  const checked = linearInput(CreateIssue, input);
  const reply = await linearGraphql(
    credential,
    `mutation OpenSesameCreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
    { input: checked },
    z.object({
      issueCreate: z.object({ success: z.literal(true), issue: Issue }),
    }),
  );
  return reply.issueCreate.issue;
}

const Project = z.object({
  id: Text,
  name: Text,
  description: z.string().max(100_000),
  url: LinearResourceUrl,
});
export type LinearProject = z.infer<typeof Project>;

export async function readLinearProject(
  credential: LinearCredential,
  id: string,
): Promise<LinearProject> {
  const checked = linearInput(Text, id);
  const reply = await linearGraphql(
    credential,
    "query OpenSesameProject($id: String!) { project(id: $id) { id name description url } }",
    { id: checked },
    z.object({ project: Project }),
  );
  return reply.project;
}

/** The UI lists the 50 most recently updated issues, without fetching a whole workspace. */
export async function listLinearIssues(
  credential: LinearCredential,
): Promise<LinearIssue[]> {
  const reply = await linearGraphql(
    credential,
    "query OpenSesameIssues { issues(first: 50, orderBy: updatedAt) { nodes { id identifier title url } } }",
    {},
    z.object({
      issues: z.object({
        nodes: z.array(Issue.omit({ description: true })).max(50),
      }),
    }),
  );
  return reply.issues.nodes.map((issue) => ({ ...issue, description: null }));
}

export async function listLinearProjects(
  credential: LinearCredential,
): Promise<LinearProject[]> {
  const reply = await linearGraphql(
    credential,
    "query OpenSesameProjects { projects(first: 50, orderBy: updatedAt) { nodes { id name url } } }",
    {},
    z.object({
      projects: z.object({
        nodes: z.array(Project.omit({ description: true })).max(50),
      }),
    }),
  );
  return reply.projects.nodes.map((project) => ({
    ...project,
    description: "",
  }));
}
