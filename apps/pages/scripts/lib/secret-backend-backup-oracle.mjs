/** Open only the actual uploaded fixture ciphertext; never inspect a browser store. */
import { isDeepStrictEqual } from "node:util";
import { expect } from "@playwright/test";
import { unwrapVaultKeyWithPin } from "../../../../packages/app-core/src/lib/vault/unlock-factor-crypto.ts";
import {
  openVaultBody,
  readVaultFile,
} from "../../../../packages/vault-core/src/vault-file.ts";

export async function openBrowserBackup(ciphertext, pin) {
  const file = readVaultFile(ciphertext);
  expect(file.header.unlocks?.pin).toBeTruthy();
  const raw = await unwrapVaultKeyWithPin(file.header.unlocks.pin, pin);
  try {
    const { body, bound } = await openVaultBody(file, raw);
    expect(bound).toBe(true);
    return body;
  } finally {
    raw.fill(0);
  }
}

export function verifyVaultTokensInBackup(body, ciphertext, width, check) {
  const credentials = body.items.filter(
    (item) =>
      item.kind === "credential" &&
      item.method.type === "token" &&
      item.deletedAt === null,
  );
  expect(credentials.length).toBeGreaterThanOrEqual(4);
  for (const item of credentials)
    expect(ciphertext.includes(item.method.token)).toBe(false);
  check(
    true,
    `${width}: actual uploaded backup decrypts to ${credentials.length} vault Token items; their plaintext is absent from the transmitted ciphertext`,
  );
}

export function verifyRestoredVaultContent(source, restored, width, check) {
  const itemsPreserved = source.items.every((item) =>
    isDeepStrictEqual(
      restored.items.find((candidate) => candidate.id === item.id),
      item,
    ),
  );
  const foldersPreserved = source.folders.every((folder) =>
    isDeepStrictEqual(
      restored.folders.find((candidate) => candidate.id === folder.id),
      folder,
    ),
  );
  check(
    itemsPreserved && foldersPreserved,
    `${width}: target re-backup opens with its own PIN and preserves all ${source.items.length} source items, including vault tokens, and ${source.folders.length} source folders`,
  );
}
