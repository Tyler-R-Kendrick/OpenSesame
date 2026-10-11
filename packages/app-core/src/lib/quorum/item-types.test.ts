/** @vitest-environment jsdom */
/**
 * `ensureQuorumTypes` against the real vault store: the two types arrive from
 * the embedded text, a vault that has them is not rewritten, and a refusal is
 * an error a screen can show. The store, the sealed body and the registry are
 * the real ones; only the writes are counted.
 */
import {
  installedDefinitions,
  itemTypeRegistry,
  syncInstalledTypes,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kvDelete } from "../kv.js";
import { VaultStore } from "../vault/store.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
  vfsSeams,
} from "../vfs.js";
import { QUORUM_TYPES } from "./item-types.generated.js";
import { type QuorumTypeHost, ensureQuorumTypes } from "./item-types.js";
import { GUARDIAN_SHARE_TYPE, TRUSTED_CIRCLE_TYPE } from "./records.js";

const PASSWORD = "correct horse battery staple";
const BODY_KEY = tombFileKey(PERSONAL_TOMB, BODY_PATH);

function textOf(id: string): string {
  const found = QUORUM_TYPES.find((type) => type.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found.text;
}

/** The definition at another version, as another release of it would ship. */
function atVersion(id: string, version: string): string {
  return textOf(id).replace('"version": "1.0.0"', `"version": "${version}"`);
}

const versionOf = (id: string) =>
  itemTypeRegistry().get(id)?.metadata.version ?? null;

function wipe(): void {
  for (const path of [
    BODY_PATH,
    HEADER_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
}

/** How many times the sealed body is written while `run` goes. */
async function bodyWrites(run: () => Promise<void>): Promise<number> {
  const original = vfsSeams.writeRaw;
  let count = 0;
  vfsSeams.writeRaw = (key, value, vaultKey) => {
    if (key === BODY_KEY) count += 1;
    return original(key, value, vaultKey);
  };
  try {
    await run();
    await vfsFlush();
  } finally {
    vfsSeams.writeRaw = original;
  }
  return count;
}

let store: VaultStore;

beforeEach(async () => {
  await vfsFlush();
  syncInstalledTypes({});
  wipe();
  store = new VaultStore();
  await store.create(PASSWORD);
});

afterEach(async () => {
  await store.flushPendingWrites();
  await vfsFlush();
  store.lock();
  syncInstalledTypes({});
});

describe("ensureQuorumTypes", () => {
  it("installs both types into a vault that has neither, from the embedded text", async () => {
    expect(versionOf(TRUSTED_CIRCLE_TYPE)).toBeNull();
    expect(versionOf(GUARDIAN_SHARE_TYPE)).toBeNull();
    await ensureQuorumTypes(store);
    expect(versionOf(TRUSTED_CIRCLE_TYPE)).toBe("1.0.0");
    expect(versionOf(GUARDIAN_SHARE_TYPE)).toBe("1.0.0");
    // Sealed into the vault body as authored: one copy of the JSON.
    expect(installedDefinitions()[TRUSTED_CIRCLE_TYPE]).toBe(
      textOf(TRUSTED_CIRCLE_TYPE),
    );
    expect(installedDefinitions()[GUARDIAN_SHARE_TYPE]).toBe(
      textOf(GUARDIAN_SHARE_TYPE),
    );
  });

  it("does not rewrite the vault body when the versions are current", async () => {
    expect(await bodyWrites(() => ensureQuorumTypes(store))).toBe(2);
    expect(await bodyWrites(() => ensureQuorumTypes(store))).toBe(0);
    expect(await bodyWrites(() => ensureQuorumTypes(store))).toBe(0);
  });

  it("finds the types again after the vault is locked and opened, and writes nothing", async () => {
    await ensureQuorumTypes(store);
    await store.flushPendingWrites();
    await vfsFlush();
    store.lock();
    syncInstalledTypes({});
    expect(versionOf(TRUSTED_CIRCLE_TYPE)).toBeNull();

    store = new VaultStore();
    await store.unlock(PASSWORD);
    expect(versionOf(TRUSTED_CIRCLE_TYPE)).toBe("1.0.0");
    expect(await bodyWrites(() => ensureQuorumTypes(store))).toBe(0);
  });

  it("installs over a lower version and leaves a higher one alone", async () => {
    await store.installItemTypeDefinition(
      atVersion(TRUSTED_CIRCLE_TYPE, "0.9.0"),
    );
    await store.installItemTypeDefinition(
      atVersion(GUARDIAN_SHARE_TYPE, "1.2.0"),
    );
    await store.flushPendingWrites();
    await vfsFlush();
    expect(versionOf(TRUSTED_CIRCLE_TYPE)).toBe("0.9.0");

    // Only the circle is behind, so only the circle is written.
    expect(await bodyWrites(() => ensureQuorumTypes(store))).toBe(1);
    expect(versionOf(TRUSTED_CIRCLE_TYPE)).toBe("1.0.0");
    expect(versionOf(GUARDIAN_SHARE_TYPE)).toBe("1.2.0");
  });

  it("throws when another publisher holds the id, and leaves their type alone", async () => {
    const theirs = atVersion(TRUSTED_CIRCLE_TYPE, "0.5.0").replace(
      "https://opensesame.dev",
      "https://other.example",
    );
    expect((await store.installItemTypeDefinition(theirs)).ok).toBe(true);
    await expect(ensureQuorumTypes(store)).rejects.toThrow(
      /trusted-circle item type could not be installed/,
    );
    expect(versionOf(TRUSTED_CIRCLE_TYPE)).toBe("0.5.0");
  });

  it("throws a failed install as an Error", async () => {
    const refusing: QuorumTypeHost = {
      installItemTypeDefinition: async () => ({
        ok: false,
        message: "the registry said no",
      }),
    };
    await expect(ensureQuorumTypes(refusing)).rejects.toThrow(
      "the registry said no",
    );
  });

  it("lets calls made together share one install", async () => {
    const seen: string[] = [];
    const counting: QuorumTypeHost = {
      installItemTypeDefinition: (text) => {
        seen.push(text);
        return store.installItemTypeDefinition(text);
      },
    };
    await Promise.all([
      ensureQuorumTypes(counting),
      ensureQuorumTypes(counting),
      ensureQuorumTypes(counting),
    ]);
    expect(seen).toEqual(QUORUM_TYPES.map((type) => type.text));
    // And once done, the next call starts fresh and finds nothing to do.
    await ensureQuorumTypes(counting);
    expect(seen).toHaveLength(QUORUM_TYPES.length);
  });
});
