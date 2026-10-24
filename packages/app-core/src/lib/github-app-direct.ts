/** Fixed-origin GitHub App REST transport, with no relay or persistent access token. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import {
  GithubDirectError,
  type GithubDirectGuard,
  assertGithubCurrent,
  signGithubAppJwt,
} from "./github-app-signing.js";

export type GithubDirectTransport = GithubDirectGuard & { fetch: typeof fetch };
export type GithubAppCredentials = { appId: string; privateKey: string };
export type GithubApiRequest = {
  method: "GET" | "POST" | "PUT";
  token?: string;
  body?: BoundaryValue;
};
const id = z.number().int().positive().safe();
const appSchema = z.object({
  id,
  slug: z.string().min(1),
  name: z.string().min(1),
  client_id: z.string().min(1).optional(),
  owner: z
    .object({ login: z.string().min(1), type: z.string().min(1) })
    .nullable()
    .optional(),
  html_url: z.string().url().nullable().optional(),
});
const installationSchema = z.object({
  id,
  account: z.object({
    login: z.string().min(1),
    type: z.string().min(1).max(64).optional(),
  }),
  repository_selection: z.enum(["all", "selected"]),
});
export type GithubDirectApp = z.infer<typeof appSchema>;
export type GithubDirectInstallation = z.infer<typeof installationSchema>;

export function githubRepositoryName(value: string): string {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(value) || value === "." || value === "..")
    throw new GithubDirectError(
      "configuration",
      "Enter a valid GitHub repository name.",
    );
  return value;
}

function responseValue<T>(schema: z.ZodType<T>, value: BoundaryValue): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new GithubDirectError(
      "response",
      "GitHub returned an unexpected response.",
    );
  return parsed.data;
}

async function readJson(
  response: Response,
  transport: GithubDirectGuard,
): Promise<BoundaryValue> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new GithubDirectError(
      "response",
      "GitHub returned an empty response.",
    );
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  transport.signal.addEventListener("abort", cancel, { once: true });
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    let size = 0;
    while (true) {
      assertGithubCurrent(transport);
      const part = await reader.read();
      assertGithubCurrent(transport);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1024 * 1024)
        throw new GithubDirectError(
          "response",
          "GitHub returned too much data.",
        );
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    const result: BoundaryValue = JSON.parse(text);
    return result;
  } finally {
    transport.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readGithubResponse(
  response: Response,
  current: GithubDirectGuard,
  allowMissing: boolean,
): Promise<BoundaryValue> {
  assertGithubCurrent(current);
  if (response.redirected) {
    await response.body?.cancel();
    assertGithubCurrent(current);
    throw new GithubDirectError(
      "response",
      "GitHub redirected this request unexpectedly.",
    );
  }
  if (allowMissing && response.status === 404) {
    await response.body?.cancel();
    assertGithubCurrent(current);
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    assertGithubCurrent(current);
    throw new GithubDirectError(
      response.status === 401 || response.status === 403
        ? "authorization"
        : "response",
      "GitHub did not authorize or complete this request.",
    );
  }
  const result = await readJson(response, current);
  assertGithubCurrent(current);
  return result;
}

export async function githubApiJson(
  transport: GithubDirectTransport,
  path: string,
  request: GithubApiRequest,
  allowMissing = false,
): Promise<BoundaryValue> {
  assertGithubCurrent(transport);
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\r\n#]/.test(path))
    throw new GithubDirectError("configuration", "Invalid GitHub API path.");
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 20000);
  const signal = AbortSignal.any([transport.signal, timeout.signal]);
  const current = {
    signal,
    assertCurrent: () => assertGithubCurrent(transport),
  };
  try {
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    if (request.token) headers.set("Authorization", `Bearer ${request.token}`);
    if (request.body !== undefined)
      headers.set("Content-Type", "application/json");
    const init: RequestInit = {
      method: request.method,
      headers,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal,
    };
    if (request.body !== undefined) init.body = JSON.stringify(request.body);
    assertGithubCurrent(current);
    const response = await transport.fetch(
      `https://api.github.com${path}`,
      init,
    );
    return await readGithubResponse(response, current, allowMissing);
  } catch (error) {
    assertGithubCurrent(current);
    if (error instanceof GithubDirectError) throw error;
    throw new GithubDirectError(
      "network",
      "GitHub could not be reached or returned an unreadable response.",
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function convertGithubAppManifest(
  transport: GithubDirectTransport,
  code: string,
) {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(code))
    throw new GithubDirectError(
      "configuration",
      "Invalid GitHub manifest conversion code.",
    );
  return responseValue(
    appSchema.extend({
      client_id: z.string().min(1),
      client_secret: z.string().min(1),
      pem: z.string().min(1).max(65536),
    }),
    await githubApiJson(transport, `/app-manifests/${code}/conversions`, {
      method: "POST",
    }),
  );
}

async function appToken(
  transport: GithubDirectTransport,
  credentials: GithubAppCredentials,
) {
  return signGithubAppJwt(credentials.appId, credentials.privateKey, transport);
}

export async function readGithubApp(
  transport: GithubDirectTransport,
  credentials: GithubAppCredentials,
): Promise<GithubDirectApp> {
  return responseValue(
    appSchema,
    await githubApiJson(transport, "/app", {
      method: "GET",
      token: await appToken(transport, credentials),
    }),
  );
}

export async function listGithubAppInstallations(
  transport: GithubDirectTransport,
  credentials: GithubAppCredentials,
): Promise<GithubDirectInstallation[]> {
  const token = await appToken(transport, credentials);
  const result: GithubDirectInstallation[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const rows = responseValue(
      z.array(installationSchema).max(100),
      await githubApiJson(
        transport,
        `/app/installations?per_page=100&page=${page}`,
        { method: "GET", token },
      ),
    );
    result.push(...rows);
    if (rows.length < 100) return result;
  }
  throw new GithubDirectError(
    "response",
    "Too many GitHub App installations to list.",
  );
}

/**
 * A token for one repository's contents, and no more than the step needs:
 * reading the backup or its branch head asks for `read`, only the step that
 * writes the backup asks for `write`.
 */
export async function createGithubInstallationToken(
  transport: GithubDirectTransport,
  credentials: GithubAppCredentials,
  installationId: number,
  repository: string,
  access: "read" | "write",
): Promise<string> {
  if (!id.safeParse(installationId).success)
    throw new GithubDirectError(
      "configuration",
      "Select a valid GitHub App installation.",
    );
  githubRepositoryName(repository);
  const token = await appToken(transport, credentials);
  const result = responseValue(
    z.object({
      token: z.string().min(1).max(4096),
      expires_at: z.string().datetime(),
    }),
    await githubApiJson(
      transport,
      `/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        token,
        body: {
          repositories: [repository],
          permissions: { contents: access, metadata: "read" },
        },
      },
    ),
  );
  if (Date.parse(result.expires_at) <= Date.now())
    throw new GithubDirectError(
      "authorization",
      "GitHub returned an expired installation token.",
    );
  assertGithubCurrent(transport);
  return result.token;
}
