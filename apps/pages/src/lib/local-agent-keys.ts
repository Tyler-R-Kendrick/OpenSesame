import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { b64urlToBytes, bytesToB64url } from "@opensesame/sdk-browser";
import { localAgentPublicKey } from "@opensesame/static-auth";
import { kvRefresh } from "./kv.js";
import {
  LocalDirectoryError,
  readLocalDirectory,
  withLocalDirectoryLock,
} from "./local-directory.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

const PATH = "config/identity-agent-keys";
const MAX_BYTES = 1_000_000;
export type LocalAgentKey = {
  principalId: string;
  credentialId: string;
  keyId: string;
  publicKeyB64: string;
  createdAt: number;
};

function isKey(value: BoundaryValue): value is LocalAgentKey {
  return (
    isJsonObject(value) &&
    isString(value.principalId) &&
    /^local_[0-9a-f-]{36}$/.test(value.principalId) &&
    isString(value.credentialId) &&
    /^[0-9a-f-]{36}$/.test(value.credentialId) &&
    isString(value.keyId) &&
    /^[A-Za-z0-9_-]{43}$/.test(value.keyId) &&
    isString(value.publicKeyB64) &&
    /^[A-Za-z0-9_-]{1,1024}$/.test(value.publicKeyB64) &&
    isNumber(value.createdAt) &&
    Number.isSafeInteger(value.createdAt) &&
    value.createdAt > 0
  );
}

export async function agentKeyMaterial(record: LocalAgentKey) {
  const value: BoundaryValue = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      b64urlToBytes(record.publicKeyB64),
    ),
  );
  const material = await localAgentPublicKey(value);
  if (material.keyId !== record.keyId)
    throw new LocalDirectoryError("Invalid agent key binding.");
  return material;
}

/** Read inside the shared directory fence when making an authority decision. */
export async function readLocalAgentKeys(
  tomb: string,
): Promise<LocalAgentKey[]> {
  await kvRefresh(tombFileKey(tomb, PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, PATH);
    if (bytes.length > MAX_BYTES)
      throw new LocalDirectoryError("Agent key storage exceeds its limit.");
    const value: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !isJsonObject(value) ||
      value.version !== 1 ||
      !Array.isArray(value.keys) ||
      value.keys.length > 1000 ||
      !value.keys.every(isKey) ||
      new Set(value.keys.map((key) => key.credentialId)).size !==
        value.keys.length ||
      new Set(value.keys.map((key) => key.keyId)).size !== value.keys.length
    )
      throw new LocalDirectoryError(
        "Invalid agent key storage. Restore a valid vault backup.",
      );
    return value.keys;
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return [];
    throw error;
  }
}

async function writeKeys(tomb: string, keys: LocalAgentKey[]) {
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, keys }));
  if (keys.length > 1000 || bytes.length > MAX_BYTES)
    throw new LocalDirectoryError("Agent key capacity reached.");
  try {
    await writeFile(tomb, PATH, bytes);
  } finally {
    notifyLocalIamChange();
  }
}

export async function requireLocalAgent(tomb: string, principalId: string) {
  const directory = await readLocalDirectory(tomb);
  if (
    !directory.entries.some(
      (entry) =>
        entry.id === principalId && entry.kind === "agent" && entry.enabled,
    )
  )
    throw new LocalDirectoryError("This agent is unavailable or disabled.");
  return directory;
}

/** Human custodian enrollment: only public material is accepted or stored. */
export async function registerLocalAgentKey(
  tomb: string,
  principalId: string,
  input: BoundaryValue,
): Promise<void> {
  let material: Awaited<ReturnType<typeof localAgentPublicKey>>;
  try {
    material = await localAgentPublicKey(structuredClone(input));
  } catch {
    throw new LocalDirectoryError(
      "Provide a public ES256 JWK, never a private key.",
    );
  }
  const publicKeyB64 = bytesToB64url(
    new TextEncoder().encode(JSON.stringify(material.publicKey)),
  );
  await withLocalDirectoryLock(tomb, async () => {
    await requireLocalAgent(tomb, principalId);
    const keys = await readLocalAgentKeys(tomb);
    if (keys.some((key) => key.keyId === material.keyId))
      throw new LocalDirectoryError(
        "This key is already enrolled. Use a distinct key for each agent.",
      );
    await writeKeys(tomb, [
      ...keys,
      {
        principalId,
        credentialId: crypto.randomUUID(),
        keyId: material.keyId,
        publicKeyB64,
        createdAt: Date.now(),
      },
    ]);
  });
}

export async function revokeLocalAgentKey(
  tomb: string,
  principalId: string,
  credentialId: string,
): Promise<void> {
  await withLocalDirectoryLock(tomb, async () => {
    const keys = await readLocalAgentKeys(tomb);
    if (
      !keys.some(
        (key) =>
          key.principalId === principalId && key.credentialId === credentialId,
      )
    )
      throw new LocalDirectoryError("This agent key is no longer available.");
    await writeKeys(
      tomb,
      keys.filter((key) => key.credentialId !== credentialId),
    );
  });
}
