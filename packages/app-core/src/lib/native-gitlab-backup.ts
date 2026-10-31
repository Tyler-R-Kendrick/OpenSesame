/** Ciphertext-only Gitlab Contents backups with immutable reads and explicit last-commit CAS. */
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  parseOfflineBackupEnvelope,
  serializeOfflineBackupEnvelope,
} from "@opensesame/vault-core";
import { z } from "zod";
import { base64ToBytes, bytesToBase64 } from "./native-base64.js";
import {
  type NativeGitlabBackupOptions,
  captureNativeGitlabBackup,
} from "./native-gitlab-backup-authority.js";
import {
  type NativeGitlabBackupTarget,
  nativeGitlabTargetPath,
} from "./native-gitlab-backup-target.js";
import { nativeResponseJson } from "./native-response-json.js";
import type { SecretBackendBackupHandle } from "./secret-backends/backup-transfer.js";
import {
  type SecretBackend,
  SecretBackendError,
  type SecretBackendItemInput,
  type SecretBackendSession,
} from "./secret-backends/types.js";
import { zodJitless } from "./zod-jitless.js";
import { asBufferSource } from "@opensesame/os-domain";

zodJitless();
const MAX_BYTES = 512 * 1024;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const file = z.object({
  file_path: z.string(),
  encoding: z.literal("base64"),
  size: z.number().int().min(1).max(MAX_BYTES),
  content: z.string().max(750000),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  commit_id: sha,
  last_commit_id: sha,
});
const reference = z.object({
  name: z.string(),
  can_push: z.literal(true),
  commit: z.object({ id: sha }),
});
const write = z.object({ file_path: z.string(), branch: z.string() });
type Owner = Awaited<ReturnType<typeof captureNativeGitlabBackup>>;
type Target = NativeGitlabBackupTarget;
type BackupWrite = {
  commit_message: string;
  encoding: "base64";
  branch: string;
  content: string;
  last_commit_id?: string;
};
function failure(
  code: ConstructorParameters<typeof SecretBackendError>[0] = "response",
): never {
  throw new SecretBackendError(
    code,
    "The encrypted GitLab backup operation did not complete.",
  );
}
function itemPath(id: string): string {
  if (
    !/^backups\/[a-f0-9-]{36}\.json$/.test(id) &&
    id !== "opensesame-vault.backup.json"
  )
    failure("configuration");
  return encodeURIComponent(id);
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
  if (
    response.status === 400 ||
    response.status === 409 ||
    response.status === 422
  )
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
      Authorization: `Bearer ${owner.saved.privateState.credentials.api_key}`,
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
      `https://gitlab.com${path}`,
      init,
    );
    owner.check();
    await responseStatus(owner, response);
    if (response.status !== (method === "POST" ? 201 : 200)) {
      await response.body?.cancel();
      failure();
    }
    if (
      !/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
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
    await request(
      owner,
      `${base}/repository/branches/${encodeURIComponent(branch)}`,
    ),
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
    await request(owner, `${base}/repository/files/${path}?ref=${revision}`),
  );
  if (
    !parsed.success ||
    parsed.data.file_path !== id ||
    parsed.data.commit_id !== revision
  )
    failure();
  let notes: string;
  try {
    const encoded = parsed.data.content.replaceAll("\n", "");
    const bytes = base64ToBytes(encoded);
    if (bytes.length !== parsed.data.size || bytesToBase64(bytes) !== encoded)
      failure();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", asBufferSource(bytes)));
    if (
      Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      ) !== parsed.data.content_sha256
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
    fields: { last_commit_id: parsed.data.last_commit_id, commit: revision },
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
      if (prior.fields.last_commit_id !== expected) failure("configuration");
    }
    const body: BackupWrite = {
      commit_message: "Back up encrypted OpenSesame vault",
      branch,
      encoding: "base64",
      content: bytesToBase64(new TextEncoder().encode(notes)),
    };
    if (expected !== undefined) body.last_commit_id = expected;
    const result = write.safeParse(
      await request(
        owner,
        `${base}/repository/files/${path}`,
        body,
        expected === undefined ? "POST" : "PUT",
      ),
    );
    if (
      !result.success ||
      result.data.file_path !== id ||
      result.data.branch !== branch
    )
      failure();
    const stored = await readBackup(
      owner,
      base,
      branch,
      id,
      await branchCommit(owner, base, branch),
    );
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
        !input.fields?.last_commit_id ||
        Object.keys(input.fields).some((key) => key !== "last_commit_id")
      )
        failure("configuration");
      return put(id, input, presented, input.fields.last_commit_id);
    },
    disconnect: async (presented: SecretBackendSession) => {
      if (presented !== session) failure("stale");
      owner.close();
    },
  };
}
export async function openNativeGitlabBackup(
  id: string,
  target: Target,
  options: NativeGitlabBackupOptions,
): Promise<SecretBackendBackupHandle> {
  const heldTarget = Object.freeze({ ...target });
  const base = nativeGitlabTargetPath(heldTarget);
  const branch = heldTarget.branch;
  const owner = await captureNativeGitlabBackup(id, heldTarget, options);
  try {
    await branchCommit(owner, base, branch);
    const session: SecretBackendSession = Object.freeze({
      id: crypto.randomUUID(),
      backendId: `native-gitlab-backup:${id}`,
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
