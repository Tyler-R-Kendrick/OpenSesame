/** Ciphertext-only Codeberg Contents backups with immutable reads and explicit blob-SHA CAS. */
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  parseOfflineBackupEnvelope,
  serializeOfflineBackupEnvelope,
} from "@opensesame/vault-core";
import { z } from "zod";
import { base64ToBytes, bytesToBase64 } from "./native-base64.js";
import {
  type NativeCodebergBackupOptions,
  captureNativeCodebergBackup,
} from "./native-codeberg-backup-authority.js";
import {
  type NativeCodebergBackupTarget,
  nativeCodebergTargetPath,
} from "./native-codeberg-backup-target.js";
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
const file = z.object({
  type: z.literal("file"),
  path: z.string(),
  sha,
  encoding: z.literal("base64"),
  size: z.number().int().min(1).max(MAX_BYTES),
  content: z.string().max(750000),
});
const reference = z.object({
  name: z.string(),
  commit: z.object({ id: sha }),
});
const write = z.object({
  content: z.object({ type: z.literal("file"), path: z.string(), sha }),
  commit: z.object({ sha }),
});
type Owner = Awaited<ReturnType<typeof captureNativeCodebergBackup>>;
type Target = NativeCodebergBackupTarget;
type BackupWrite = {
  message: string;
  branch: string;
  content: string;
  sha?: string;
};
function failure(
  code: ConstructorParameters<typeof SecretBackendError>[0] = "response",
): never {
  throw new SecretBackendError(
    code,
    "The encrypted Codeberg backup operation did not complete.",
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
  if (response.status === 409 || response.status === 422)
    failure("configuration");
  failure();
}
async function request(
  owner: Owner,
  path: string,
  body?: BoundaryValue,
  method: "GET" | "POST" | "PUT" = "GET",
): Promise<BoundaryValue> {
  await owner.current();
  const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(20000)]);
  try {
    const headers = new Headers({
      Authorization: `Bearer ${owner.grant.accessToken}`,
      Accept: "application/json",
    });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const init: RequestInit = {
      method,
      headers,
      signal,
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await owner.transport.fetch(
      `https://codeberg.org${path}`,
      init,
    );
    owner.check();
    await responseStatus(owner, response);
    if (response.status !== (method === "POST" ? 201 : 200)) {
      await response.body?.cancel();
      failure();
    }
    const value = await nativeResponseJson(response, {
      maxBytes: 1024 * 1024,
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
    await request(owner, `${base}/branches/${encodeURIComponent(branch)}`),
  );
  if (!head.success || head.data.name !== branch) failure();
  return head.data.commit.id;
}
async function readBackup(
  owner: Owner,
  base: string,
  branch: string,
  id: string,
  commit?: string,
) {
  const path = itemPath(id);
  const revision = commit ?? (await branchCommit(owner, base, branch));
  const parsed = file.safeParse(
    await request(owner, `${base}/contents/${path}?ref=${revision}`),
  );
  if (!parsed.success || parsed.data.path !== id) failure();
  let notes: string;
  try {
    const encoded = parsed.data.content.replaceAll("\n", "");
    const bytes = base64ToBytes(encoded);
    if (bytes.length !== parsed.data.size || bytesToBase64(bytes) !== encoded)
      failure();
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-1",
        new Uint8Array([
          ...new TextEncoder().encode(`blob ${bytes.length}\0`),
          ...bytes,
        ]),
      ),
    );
    if (
      Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      ) !== parsed.data.sha
    )
      failure();
    notes = ciphertext(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return failure();
  }
  owner.check();
  return {
    id,
    name: id,
    kind: "note" as const,
    notes,
    secret: "",
    fields: { sha: parsed.data.sha, commit: revision },
  };
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
    return readBackup(owner, base, branch, id);
  }
  async function put(
    id: string,
    input: SecretBackendItemInput,
    presented: SecretBackendSession,
    expected?: string,
  ) {
    check(presented);
    const path = itemPath(id);
    if (
      !input.name.trim() ||
      input.kind !== "note" ||
      input.secret ||
      input.username ||
      input.url
    )
      failure("configuration");
    const notes = ciphertext(input.notes);
    if (expected !== undefined) {
      if (!sha.safeParse(expected).success) failure("configuration");
      const prior = await getItem(id, presented);
      if (prior.fields.sha !== expected) failure("configuration");
    }
    const body: BackupWrite = {
      message: "Back up encrypted OpenSesame vault",
      branch,
      content: bytesToBase64(new TextEncoder().encode(notes)),
    };
    if (expected !== undefined) body.sha = expected;
    const result = write.safeParse(
      await request(
        owner,
        `${base}/contents/${path}`,
        body,
        expected === undefined ? "POST" : "PUT",
      ),
    );
    if (!result.success || result.data.content.path !== id) failure();
    const stored = await readBackup(
      owner,
      base,
      branch,
      id,
      result.data.commit.sha,
    );
    if (stored.fields.sha !== result.data.content.sha || stored.notes !== notes)
      failure();
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
        !input.fields?.sha ||
        Object.keys(input.fields).some((key) => key !== "sha")
      )
        failure("configuration");
      return put(id, input, presented, input.fields.sha);
    },
    disconnect: async (presented: SecretBackendSession) => {
      if (presented !== session) failure("stale");
      owner.close();
    },
  };
}
export async function openNativeCodebergBackup(
  id: string,
  target: Target,
  options: NativeCodebergBackupOptions,
): Promise<SecretBackendBackupHandle> {
  const heldTarget = Object.freeze({ ...target });
  const base = nativeCodebergTargetPath(heldTarget);
  const branch = heldTarget.branch;
  const owner = await captureNativeCodebergBackup(id, heldTarget, options);
  try {
    await branchCommit(owner, base, branch);
    const session: SecretBackendSession = Object.freeze({
      id: crypto.randomUUID(),
      backendId: `native-codeberg-backup:${id}`,
      authenticatedAt: new Date().toISOString(),
      signal: owner.signal,
    });
    const methods = operations(owner, base, branch, session);
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
