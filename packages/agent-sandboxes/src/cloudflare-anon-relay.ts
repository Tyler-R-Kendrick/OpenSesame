/**
 * Anonymous Cloudflare relay deployment.
 *
 * Provisions a temporary preview account (proof of work, no signup,
 * no claim), deploys the virtual-network relay Worker plus its KV
 * cookie jar, and returns a relay URL/token pair for the WASM lane.
 * The account and its resources expire on their own; `close()` also
 * deletes the Worker and namespace best-effort. Nothing here ever
 * asks a person to claim the account — the claim URL is returned
 * only so callers may surface it if they want persistence.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type CloudflareTemporaryAccount,
  provisionCloudflareTemporaryAccount,
} from "./cloudflare-provisioning.js";
import { CLOUDFLARE_RELAY_WORKER_SOURCE } from "./cloudflare-relay-worker.js";

export interface CloudflareWorkerBinding {
  type: string;
  name: string;
  [key: string]: string;
}

export interface AnonymousCloudflareRelay {
  relayUrl: string;
  relayToken: string;
  account: CloudflareTemporaryAccount;
  close(): Promise<void>;
}

export interface AnonymousCloudflareRelayOptions {
  fetchImpl?: typeof fetch;
  /** Reuse an already-provisioned temporary account. */
  account?: CloudflareTemporaryAccount;
  /** Override provisioning (tests). */
  provision?: () => Promise<CloudflareTemporaryAccount>;
  /** Extra service bindings for the relay (workers.dev targets). */
  serviceBindings?: Record<string, string>;
  /** Readiness poll budget for workers.dev propagation. */
  readyTimeoutMs?: number;
}

const apiResultSchema = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
  errors: z
    .array(z.object({ code: z.number(), message: z.string() }))
    .optional(),
});

const subdomainSchema = z.object({ subdomain: z.string().min(1) });
const kvNamespaceSchema = z.object({ id: z.string().min(1) });

type FetchImpl = typeof fetch;

async function api(
  fetchImpl: FetchImpl,
  account: CloudflareTemporaryAccount,
  method: string,
  path: string,
  body?: BodyInit,
  contentType?: string,
): Promise<z.infer<typeof apiResultSchema>> {
  const headers = new Headers({ authorization: `Bearer ${account.apiToken}` });
  if (contentType) headers.set("content-type", contentType);
  const init: RequestInit = { method, headers, redirect: "error" };
  if (body !== undefined) init.body = body;
  // Fresh temporary tokens can take seconds to propagate; retry the
  // transient 401/403 window before treating auth as refused. Form
  // bodies are single-use streams in some runtimes, so only replay
  // replayable (non-FormData) requests.
  let response = await fetchImpl(
    `https://api.cloudflare.com/client/v4${path}`,
    init,
  );
  for (
    let attempt = 0;
    (response.status === 401 || response.status === 403) &&
    attempt < 10 &&
    !(body instanceof FormData);
    attempt++
  ) {
    await new Promise((r) => setTimeout(r, 3000));
    response = await fetchImpl(
      `https://api.cloudflare.com/client/v4${path}`,
      init,
    );
  }
  const parsed = apiResultSchema.parse(await response.json());
  if (!response.ok || !parsed.success)
    throw new Error(
      `anonymous cloudflare deploy failed (${response.status} ${method} ${path}): ${
        parsed.errors?.[0]?.message ?? "unknown error"
      }`,
    );
  return parsed;
}

/** Create a KV namespace in a temporary account; returns its id. */
export async function createTemporaryKvNamespace(
  account: CloudflareTemporaryAccount,
  title: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string> {
  const created = await api(
    fetchImpl,
    account,
    "POST",
    `/accounts/${account.accountId}/storage/kv/namespaces`,
    JSON.stringify({ title }),
    "application/json",
  );
  return kvNamespaceSchema.parse(created.result).id;
}

export async function deployTemporaryWorker(
  account: CloudflareTemporaryAccount,
  name: string,
  source: string,
  bindings: CloudflareWorkerBinding[],
  fetchImpl: FetchImpl = fetch,
): Promise<void> {
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      main_module: "worker.js",
      compatibility_date: "2025-01-01",
      bindings,
    }),
  );
  form.set(
    "worker.js",
    new Blob([source], { type: "application/javascript+module" }),
    "worker.js",
  );
  await api(
    fetchImpl,
    account,
    "PUT",
    `/accounts/${account.accountId}/workers/scripts/${name}`,
    form,
  );
  await api(
    fetchImpl,
    account,
    "POST",
    `/accounts/${account.accountId}/workers/scripts/${name}/subdomain`,
    JSON.stringify({ enabled: true }),
    "application/json",
  );
}

async function workersSubdomain(
  fetchImpl: FetchImpl,
  account: CloudflareTemporaryAccount,
): Promise<string> {
  try {
    const found = await api(
      fetchImpl,
      account,
      "GET",
      `/accounts/${account.accountId}/workers/subdomain`,
    );
    return subdomainSchema.parse(found.result).subdomain;
  } catch {
    const created = await api(
      fetchImpl,
      account,
      "POST",
      `/accounts/${account.accountId}/workers/subdomain`,
      JSON.stringify({ subdomain: `os-${randomUUID().slice(0, 8)}` }),
      "application/json",
    );
    return subdomainSchema.parse(created.result).subdomain;
  }
}

export async function deployAnonymousCloudflareRelay(
  options: AnonymousCloudflareRelayOptions = {},
): Promise<AnonymousCloudflareRelay> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const provisionOpts = options.fetchImpl
    ? { fetchImpl: options.fetchImpl }
    : {};
  const account =
    options.account ??
    (await (options.provision?.() ??
      provisionCloudflareTemporaryAccount(provisionOpts)));
  const subdomain = await workersSubdomain(fetchImpl, account);
  const kvId = await createTemporaryKvNamespace(
    account,
    `os-relay-${randomUUID().slice(0, 8)}`,
    fetchImpl,
  );
  const relayToken = randomUUID() + randomUUID();
  const bindings: CloudflareWorkerBinding[] = [
    { type: "plain_text", name: "RELAY_TOKEN", text: relayToken },
    { type: "kv_namespace", name: "RELAY_KV", namespace_id: kvId },
  ];
  if (options.serviceBindings) {
    const envNames: Record<string, string> = {};
    for (const [prefix, service] of Object.entries(options.serviceBindings)) {
      const name = `SVC_${service.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}`;
      envNames[prefix] = name;
      bindings.push({ type: "service", name, service });
    }
    bindings.push({
      type: "plain_text",
      name: "SERVICE_BINDINGS_JSON",
      text: JSON.stringify(envNames),
    });
  }
  const scriptName = `os-relay-${randomUUID().slice(0, 8)}`;
  await deployTemporaryWorker(
    account,
    scriptName,
    CLOUDFLARE_RELAY_WORKER_SOURCE,
    bindings,
    fetchImpl,
  );
  const relayUrl = `https://${scriptName}.${subdomain}.workers.dev`;
  const deadline = Date.now() + (options.readyTimeoutMs ?? 120_000);
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try {
      const probe = await fetchImpl(`${relayUrl}/fetch`, {
        method: "POST",
        body: "{}",
      });
      ready = probe.status === 401;
    } catch {
      ready = false;
    }
    if (!ready) await new Promise((r) => setTimeout(r, 3000));
  }
  if (!ready)
    throw new Error("anonymous cloudflare relay did not become ready");
  return {
    relayUrl,
    relayToken,
    account,
    close: async () => {
      await api(
        fetchImpl,
        account,
        "DELETE",
        `/accounts/${account.accountId}/workers/scripts/${scriptName}`,
      ).catch(() => {});
      await api(
        fetchImpl,
        account,
        "DELETE",
        `/accounts/${account.accountId}/storage/kv/namespaces/${kvId}`,
      ).catch(() => {});
    },
  };
}
