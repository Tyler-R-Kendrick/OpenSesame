/**
 * Anonymous Vercel relay deployment.
 *
 * Bootstraps an anonymous temporary project (`POST
 * /v1/anonymous/projects` — no signup, no claim), uploads the
 * virtual-network relay functions with the scoped token it returns,
 * and creates a production deployment on the temporary `tmp.now`
 * alias. The project expires on its own (~1 hour); `close()` also
 * deletes the deployment best-effort. Nothing here ever asks a
 * person to claim the project — the claim URL is returned only so
 * callers may surface it if they want persistence.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AnonymousRelayDeployment } from "./wasm-provider.js";
import { WasmRelayProvider } from "./wasm-provider.js";
import {
  VERCEL_RELAY_CLOSE_SOURCE,
  VERCEL_RELAY_FETCH_SOURCE,
} from "./vercel-relay-function.js";

export interface VercelAnonymousProject {
  token: string;
  projectId: string;
  claimUrl: string;
  expiresAt: number;
}

export interface AnonymousVercelRelay extends AnonymousRelayDeployment {
  project: VercelAnonymousProject;
}

export interface AnonymousVercelRelayOptions {
  fetchImpl?: typeof fetch;
  /** Reuse an already-bootstrapped anonymous project. */
  project?: VercelAnonymousProject;
  /** Readiness poll budget for deployment propagation. */
  readyTimeoutMs?: number;
}

const projectSchema = z.object({
  token: z.string().min(1),
  projectId: z.string().min(1),
  claimUrl: z.string().min(1),
  expiresAt: z.number(),
});

const deploymentSchema = z.object({
  id: z.string().min(1),
  url: z.string().optional(),
  alias: z.array(z.string()).optional(),
});

type FetchImpl = typeof fetch;

const API = "https://api.vercel.com";

export async function bootstrapAnonymousVercelProject(
  fetchImpl: FetchImpl = fetch,
): Promise<VercelAnonymousProject> {
  const response = await fetchImpl(`${API}/v1/anonymous/projects?surface=cli`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok)
    throw new Error(
      `anonymous vercel project bootstrap failed (${response.status})`,
    );
  return projectSchema.parse(await response.json());
}

async function uploadFile(
  fetchImpl: FetchImpl,
  token: string,
  content: string,
): Promise<{ sha: string; size: number }> {
  const bytes = new TextEncoder().encode(content);
  const sha = createHash("sha1").update(bytes).digest("hex");
  const response = await fetchImpl(`${API}/v2/files`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
      "x-vercel-digest": sha,
    },
    body: bytes,
  });
  if (!response.ok)
    throw new Error(`anonymous vercel file upload failed (${response.status})`);
  return { sha, size: bytes.length };
}

const FUNC_CONFIG = JSON.stringify({
  runtime: "nodejs22.x",
  handler: "index.js",
  launcherType: "Nodejs",
  shouldAddHelpers: true,
});

/**
 * Anonymous deployments must upload prebuilt Build Output. Translate
 * the small logical file set this lane uses (`api/<name>.js`
 * functions, `index.html`, `vercel.json` rewrites) into that layout.
 */
function toPrebuiltOutput(
  sources: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {
    ".vercel/output/builds.json": JSON.stringify({
      target: "production",
      argv: [],
      builds: [],
    }),
  };
  const routes: unknown[] = [{ handle: "filesystem" }];
  for (const [file, content] of Object.entries(sources)) {
    if (file === "vercel.json") {
      const parsed = z
        .object({
          rewrites: z
            .array(z.object({ source: z.string(), destination: z.string() }))
            .optional(),
        })
        .parse(JSON.parse(content));
      for (const rewrite of parsed.rewrites ?? [])
        routes.push({ src: rewrite.source, dest: rewrite.destination });
      continue;
    }
    const func = /^api\/(.+)\.js$/u.exec(file);
    if (func) {
      out[`.vercel/output/functions/api/${func[1]}.func/index.js`] = content;
      out[`.vercel/output/functions/api/${func[1]}.func/.vc-config.json`] =
        FUNC_CONFIG;
      continue;
    }
    out[`.vercel/output/static/${file}`] = content;
  }
  out[".vercel/output/config.json"] = JSON.stringify({ version: 3, routes });
  return out;
}

/** Deploy one file set to an anonymous project; returns its base URL. */
export async function deployAnonymousVercelApp(
  project: VercelAnonymousProject,
  name: string,
  sources: Record<string, string>,
  env: Record<string, string> = {},
  fetchImpl: FetchImpl = fetch,
  readyTimeoutMs = 180_000,
): Promise<{ baseUrl: string; deploymentId: string }> {
  const files = [];
  for (const [file, content] of Object.entries(toPrebuiltOutput(sources))) {
    const { sha, size } = await uploadFile(fetchImpl, project.token, content);
    files.push({ file, sha, size });
  }
  const created = await fetchImpl(
    `${API}/v13/deployments?skipAutoDetectionConfirmation=1&prebuilt=1`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${project.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name,
        project: project.projectId,
        files,
        env,
        target: "production",
      }),
    },
  );
  if (!created.ok)
    throw new Error(
      `anonymous vercel deployment failed (${created.status}): ${await created.text()}`,
    );
  const deployment = deploymentSchema.parse(await created.json());
  // The public tmp.now alias is assigned asynchronously; the initial
  // vercel.app alias sits behind Vercel Authentication.
  const deadline = Date.now() + readyTimeoutMs;
  let host = (deployment.alias ?? []).find((a) => a.endsWith(".tmp.now"));
  while (!host && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const polled = await fetchImpl(`${API}/v13/deployments/${deployment.id}`, {
      headers: { authorization: `Bearer ${project.token}` },
    }).catch(() => null);
    if (polled?.ok) {
      const current = deploymentSchema.parse(await polled.json());
      host = (current.alias ?? []).find((a) => a.endsWith(".tmp.now"));
    }
  }
  if (!host)
    throw new Error("anonymous vercel deployment never got a tmp.now alias");
  return { baseUrl: `https://${host}`, deploymentId: deployment.id };
}

export async function deployAnonymousVercelRelay(
  options: AnonymousVercelRelayOptions = {},
): Promise<AnonymousVercelRelay> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const project =
    options.project ?? (await bootstrapAnonymousVercelProject(fetchImpl));
  const relayToken = randomUUID() + randomUUID();
  const { baseUrl: relayBase, deploymentId } = await deployAnonymousVercelApp(
    project,
    "opensesame-relay",
    {
      "api/fetch.js": VERCEL_RELAY_FETCH_SOURCE,
      "api/close.js": VERCEL_RELAY_CLOSE_SOURCE,
      "index.html": "<html><body>opensesame relay</body></html>",
    },
    { RELAY_TOKEN: relayToken },
    fetchImpl,
    options.readyTimeoutMs ?? 180_000,
  );
  const deadline = Date.now() + (options.readyTimeoutMs ?? 180_000);
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try {
      const probe = await fetchImpl(`${relayBase}/api/fetch`, {
        method: "POST",
        body: "{}",
      });
      ready = probe.status === 401;
    } catch {
      ready = false;
    }
    if (!ready) await new Promise((r) => setTimeout(r, 3000));
  }
  if (!ready) throw new Error("anonymous vercel relay did not become ready");
  return {
    relayUrl: `${relayBase}/api`,
    relayToken,
    project,
    close: async () => {
      await fetchImpl(`${API}/v13/deployments/${deploymentId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${project.token}` },
      }).catch(() => {});
    },
  };
}

/** WASM lane bound to a per-run anonymous Vercel relay deployment. */
export class VercelAnonProvider extends WasmRelayProvider {
  override readonly id = "vercel" as const;

  constructor(
    options: {
      deployRelay?: () => Promise<AnonymousRelayDeployment>;
      readyTimeoutMs?: number;
    } = {},
  ) {
    super({
      anonymousRelay: "vercel",
      ...(options.deployRelay ? { deployRelay: options.deployRelay } : {}),
      ...(options.readyTimeoutMs !== undefined
        ? { readyTimeoutMs: options.readyTimeoutMs }
        : {}),
    });
  }
}
