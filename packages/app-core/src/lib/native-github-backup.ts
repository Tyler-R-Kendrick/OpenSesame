/** Ciphertext-only GitHub Contents backups with immutable reads and explicit blob-SHA CAS. */
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  parseOfflineBackupEnvelope,
  serializeOfflineBackupEnvelope,
} from "@opensesame/vault-core";
import { z } from "zod";
import type { GithubBackupTarget } from "./github-app-backup-direct.js";
import { base64ToBytes, bytesToBase64 } from "./native-base64.js";
import {
  type NativeGithubBackupOptions,
  captureNativeGithubBackup,
} from "./native-github-backup-authority.js";
import {
  nativeGithubOrigin,
  nativeGithubToken,
} from "./native-github-personal-http.js";
import { invalidateNativeGithubPersonal } from "./native-github-personal-state.js";
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
  ref: z.string(),
  object: z.object({ type: z.literal("commit"), sha }),
});
const write = z.object({
  content: z.object({ type: z.literal("file"), path: z.string(), sha }),
  commit: z.object({ sha }),
});
type Owner = Awaited<ReturnType<typeof captureNativeGithubBackup>>;
type Target = Pick<GithubBackupTarget, "owner" | "repo" | "branch">;
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
    "The encrypted GitHub backup operation did not complete.",
  );
}
function targetPath(target: Target): string {
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(target.owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(target.repo) ||
    /^\.{1,2}$/.test(target.repo) ||
    !target.branch ||
    target.branch.length > 255 ||
    /[\s~^:?*\[\\]/.test(target.branch) ||
    Array.from(target.branch).some(
      (char) => char.charCodeAt(0) < 33 || char.charCodeAt(0) === 127,
    ) ||
    target.branch.includes("..") ||
    target.branch.includes("@{") ||
    target.branch
      .split("/")
      .some(
        (part) =>
          !part ||
          part.startsWith(".") ||
          part.endsWith(".") ||
          part.endsWith(".lock"),
      )
  )
    failure("configuration");
  return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}
function itemPath(id: string): string {
  if (
    !/^backups\/[a-f0-9-]{36}\.json$/.test(id) &&
    id !== "opensesame-vault.backup.json"
  )
    failure("configuration");
  return id.split("/").map(encodeURIComponent).join("/");
}
/** Shared optional configuration: an empty target keeps personal-token use unchanged. */
export function nativeGithubBackupTarget(
  parameters: Readonly<Record<string, string>>,
): Target | null {
  if (
    Object.keys(parameters).some(
      (key) => !["backup_owner", "backup_repo", "backup_branch"].includes(key),
    )
  )
    failure("configuration");
  const target = {
    owner: (parameters.backup_owner ?? "").trim(),
    repo: (parameters.backup_repo ?? "").trim(),
    branch: (parameters.backup_branch ?? "").trim(),
  };
  if (!target.owner && !target.repo && !target.branch) return null;
  targetPath(target);
  return target;
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
      await invalidateNativeGithubPersonal(owner.saved, owner.transport);
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
): Promise<BoundaryValue> {
  await owner.current();
  const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(20000)]);
  try {
    const headers = new Headers({
      Authorization: `Bearer ${nativeGithubToken(owner.saved.privateState.credentials.api_key ?? "")}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const init: RequestInit = {
      method: body === undefined ? "GET" : "PUT",
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
      `${nativeGithubOrigin}${path}`,
      init,
    );
    owner.check();
    await responseStatus(owner, response);
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
async function readBackup(
  owner: Owner,
  base: string,
  branch: string,
  id: string,
) {
  const path = itemPath(id);
  const head = reference.safeParse(
    await request(
      owner,
      `${base}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
    ),
  );
  if (!head.success || head.data.ref !== `refs/heads/${branch}`) failure();
  const parsed = file.safeParse(
    await request(
      owner,
      `${base}/contents/${path}?ref=${head.data.object.sha}`,
    ),
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
    fields: { sha: parsed.data.sha, commit: head.data.object.sha },
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
      await request(owner, `${base}/contents/${path}`, body),
    );
    if (!result.success || result.data.content.path !== id) failure();
    const stored = await getItem(id, presented);
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
export async function openNativeGithubBackup(
  id: string,
  target: Target,
  options: NativeGithubBackupOptions,
): Promise<SecretBackendBackupHandle> {
  const base = targetPath(target);
  const branch = target.branch;
  const owner = await captureNativeGithubBackup(id, options);
  try {
    const session: SecretBackendSession = Object.freeze({
      id: crypto.randomUUID(),
      backendId: `native-github-backup:${id}`,
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
