/** Ciphertext-only Bitbucket Source API; explicit branch-parent CAS and immutable reads. */
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  parseOfflineBackupEnvelope,
  serializeOfflineBackupEnvelope,
} from "@opensesame/vault-core";
import { z } from "zod";
import {
  type NativeBitbucketBackupOptions,
  type NativeBitbucketBackupTarget,
  captureNativeBitbucketBackup,
  nativeBitbucketTargetPath,
} from "./native-bitbucket-backup-authority.js";
import { nativeResponseJson } from "./native-response-json.js";
import type { SecretBackendBackupHandle } from "./secret-backends/backup-transfer.js";
import {
  type SecretBackend,
  SecretBackendError,
  type SecretBackendItemInput,
  type SecretBackendSession,
} from "./secret-backends/types.js";
import { zodJitless } from "./zod-jitless.js";
zodJitless();
const MAX_BYTES = 512 * 1024;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const reference = z.object({
  name: z.string(),
  target: z.object({ hash: sha }),
});
const commit = z.object({
  hash: sha,
  parents: z.array(z.object({ hash: sha })).length(1),
});
const file = z.object({
  type: z.literal("commit_file"),
  path: z.string(),
  size: z.number().int().min(1).max(MAX_BYTES),
  attributes: z.array(z.string()).length(0),
});
type Owner = Awaited<ReturnType<typeof captureNativeBitbucketBackup>>;
function failure(
  code: ConstructorParameters<typeof SecretBackendError>[0] = "response",
): never {
  throw new SecretBackendError(
    code,
    "The encrypted Bitbucket backup operation did not complete.",
  );
}
function itemPath(id: string): string {
  if (
    !/^backups\/[a-f0-9-]{36}\.json$/.test(id) &&
    id !== "opensesame-vault.backup.json"
  )
    failure("configuration");
  return id.split("/").map(encodeURIComponent).join("/");
}
function ciphertext(text: string): string {
  if (new TextEncoder().encode(text).length > MAX_BYTES) failure("unsupported");
  try {
    return serializeOfflineBackupEnvelope(parseOfflineBackupEnvelope(text));
  } catch {
    return failure();
  }
}
async function responseStatus(owner: Owner, response: Response) {
  if (response.ok && !response.redirected) return;
  await response.body?.cancel();
  if (response.status === 401) {
    try {
      await owner.invalidate();
    } finally {
      owner.close();
    }
    failure("authentication");
  }
  if (response.status === 404) failure("not-found");
  if ([400, 409, 422].includes(response.status)) failure("configuration");
  failure();
}
async function request(
  owner: Owner,
  path: string,
  body?: URLSearchParams,
): Promise<BoundaryValue> {
  await owner.current();
  const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(20000)]);
  try {
    const headers = new Headers(owner.headers);
    headers.set("Accept", "application/json");
    if (body) headers.set("Content-Type", "application/x-www-form-urlencoded");
    const init: RequestInit = {
      method: body ? "POST" : "GET",
      headers,
      signal,
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    };
    if (body) init.body = body.toString();
    const response = await owner.transport.fetch(
      `https://api.bitbucket.org${path}`,
      init,
    );
    owner.check();
    await responseStatus(owner, response);
    if (
      response.status !== (body ? 201 : 200) ||
      !/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      await response.body?.cancel();
      failure();
    }
    const value = await nativeResponseJson(response, {
      maxBytes: body ? 65536 : MAX_BYTES,
      signal,
      fatalUtf8: true,
    });
    await owner.current();
    return value;
  } catch (error) {
    if (error instanceof SecretBackendError) throw error;
    owner.check();
    return failure("network");
  }
}
async function branchCommit(owner: Owner, base: string, branch: string) {
  const head = reference.safeParse(
    await request(owner, `${base}/refs/branches/${encodeURIComponent(branch)}`),
  );
  if (!head.success || head.data.name !== branch) failure();
  return head.data.target.hash;
}
async function readBackup(
  owner: Owner,
  base: string,
  id: string,
  revision: string,
) {
  const path = itemPath(id);
  const url = `${base}/src/${revision}/${path}`;
  const metadata = file.safeParse(await request(owner, `${url}?format=meta`));
  if (!metadata.success || metadata.data.path !== id) failure();
  const notes = ciphertext(JSON.stringify(await request(owner, url)));
  if (new TextEncoder().encode(notes).length !== metadata.data.size) failure();
  owner.check();
  return {
    id,
    name: id,
    kind: "note" as const,
    notes,
    secret: "",
    fields: { commit: revision },
  };
}
async function exists(
  owner: Owner,
  base: string,
  revision: string,
  id: string,
) {
  try {
    await request(owner, `${base}/src/${revision}/${itemPath(id)}?format=meta`);
    return true;
  } catch (error) {
    if (error instanceof SecretBackendError && error.code === "not-found")
      return false;
    throw error;
  }
}

function operations(
  owner: Owner,
  base: string,
  branch: string,
  session: SecretBackendSession,
) {
  const check = (presented: SecretBackendSession) => {
    owner.check();
    if (presented !== session) failure("stale");
  };
  async function getItem(id: string, presented: SecretBackendSession) {
    check(presented);
    itemPath(id);
    return readBackup(owner, base, id, await branchCommit(owner, base, branch));
  }
  async function put(
    id: string,
    input: SecretBackendItemInput,
    presented: SecretBackendSession,
    expected?: string,
  ) {
    check(presented);
    itemPath(id);
    if (
      !input.name.trim() ||
      input.kind !== "note" ||
      input.secret ||
      input.username ||
      input.url
    )
      failure("configuration");
    const notes = ciphertext(input.notes);
    const parent = await branchCommit(owner, base, branch);
    if (expected !== undefined) {
      if (!sha.safeParse(expected).success || expected !== parent)
        failure("configuration");
      await readBackup(owner, base, id, parent);
    } else {
      if (await exists(owner, base, parent, id)) failure("configuration");
    }
    const query = new URLSearchParams({
      branch,
      parents: parent,
      message: "Back up encrypted OpenSesame vault",
    });
    const body = new URLSearchParams({ [`/${id}`]: notes });
    const written = commit.safeParse(
      await request(owner, `${base}/src?${query}`, body),
    );
    if (
      !written.success ||
      written.data.hash === parent ||
      written.data.parents[0]?.hash !== parent
    )
      failure();
    const stored = await readBackup(owner, base, id, written.data.hash);
    if (stored.notes !== notes) failure();
    return stored;
  }
  return {
    getItem,
    createItem: async (
      input: SecretBackendItemInput,
      presented: SecretBackendSession,
    ) => {
      if (input.fields && Object.keys(input.fields).length)
        failure("configuration");
      return put(`backups/${crypto.randomUUID()}.json`, input, presented);
    },
    updateItem: async (
      id: string,
      input: SecretBackendItemInput,
      presented: SecretBackendSession,
    ) => {
      if (
        !input.fields?.commit ||
        !sha.safeParse(input.fields.commit).success ||
        Object.keys(input.fields).some((key) => key !== "commit")
      )
        failure("configuration");
      return put(id, input, presented, input.fields.commit);
    },
    disconnect: async (presented: SecretBackendSession) => {
      if (presented !== session) failure("stale");
      owner.close();
    },
  };
}
export async function openNativeBitbucketBackup(
  id: string,
  target: NativeBitbucketBackupTarget,
  options: NativeBitbucketBackupOptions,
): Promise<SecretBackendBackupHandle> {
  const held = Object.freeze({ ...target });
  const base = nativeBitbucketTargetPath(held);
  const owner = await captureNativeBitbucketBackup(id, held, options);
  try {
    await branchCommit(owner, base, held.branch);
    const session: SecretBackendSession = Object.freeze({
      id: crypto.randomUUID(),
      backendId: `native-bitbucket-backup:${id}`,
      authenticatedAt: new Date().toISOString(),
      signal: owner.signal,
    });
    const methods = operations(owner, base, held.branch, session);
    const backend: SecretBackend = {
      id: session.backendId,
      name: owner.saved.configuration.displayName,
      signal: owner.signal,
      capabilities: {
        itemKinds: ["note"],
        itemFields: ["notes"],
        vaultBackup: { kind: "note", field: "notes", maxBytes: MAX_BYTES },
        list: false,
        get: true,
        create: true,
        update: true,
        delete: false,
        import: false,
      },
      authenticate: async () => failure("unsupported"),
      listItems: async () => failure("unsupported"),
      getNotes: async (reference, presented) =>
        (await methods.getItem(reference, presented)).notes,
      ...methods,
    };
    return { backend, session };
  } catch (error) {
    owner.close();
    throw error;
  }
}
