/**
 * What an owner dealt, at rest (ADR 0149, ADR 0175): on the real vault's own
 * files, sealed under its key, with nothing readable in what reaches storage
 * and nothing in a file's name, and still there when the vault is closed and
 * opened again, until every contact's receipt is in.
 */
import { kvFileName, kvGet } from "@opensesame/app-core/lib/kv.js";
import { toB64url } from "@opensesame/app-core/lib/quorum/bytes.js";
import {
  Clock,
  type Device,
  device,
  oneGroup,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  DEFAULT_TIMING,
  type DeskPorts,
  acceptGuardian,
  acceptInvitation,
  beginCircle,
  createFromDraft,
  custodyStatus,
  readDealt,
  recordReceipt,
  retireCircle,
  takeWelcome,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  KeyRing,
  ORIGIN,
  PAYLOAD,
  RP_ID,
} from "@opensesame/app-core/lib/quorum/world.test-support.js";
import type { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  listDir,
  readFile,
  tombFileKey,
  vfsFlush,
  vfsSeams,
} from "@opensesame/app-core/lib/vfs.js";
import { afterEach, describe, expect, it } from "vitest";
import { PENDING_DIR, tombPendingStore } from "../pending-store.js";
import { vaultRecordStore } from "../vault-records.js";
import {
  closeVault,
  openVault,
  reopenVault,
} from "../vault-records.test-support.js";

// Long and odd enough that it cannot turn up in a sealed envelope by chance.
const LABEL = "Lovelace Family Emergency Circle";
const NAMES = ["Ada", "Ben", "Cy"] as const;

let live: VaultStore | null = null;

afterEach(async () => {
  if (live) await closeVault(live);
  live = null;
});

function ofVault(vault: VaultStore, clock: Clock): DeskPorts {
  return {
    now: clock.date,
    origin: ORIGIN,
    rpId: RP_ID,
    ceremony: new KeyRing(1).ceremony(),
    pending: tombPendingStore(vault.activeTomb()),
    records: vaultRecordStore(vault),
    tomb: vault.activeTomb(),
  };
}

type Reached<T> = Readonly<{ value: T; values: string[]; names: string[] }>;

/** Everything the VFS is asked to write while `run` goes, values and names as they reach storage. */
async function reached<T>(run: () => Promise<T>): Promise<Reached<T>> {
  const values: string[] = [];
  const names: string[] = [];
  const original = vfsSeams.writeRaw;
  vfsSeams.writeRaw = (key, value, vaultKey) => {
    values.push(value);
    names.push(key, kvFileName(key));
    return original(key, value, vaultKey);
  };
  try {
    const value = await run();
    await vfsFlush();
    return { value, values, names };
  } finally {
    vfsSeams.writeRaw = original;
  }
}

/** Every key of every ceremony resting in this vault, read from the sealed files themselves. */
async function restingKeys(vault: VaultStore): Promise<string[]> {
  const tomb = vault.activeTomb();
  const keys: string[] = [];
  for (const path of await listDir(tomb, PENDING_DIR)) {
    const doc = JSON.parse(
      new TextDecoder().decode(await readFile(tomb, path)),
    );
    keys.push(doc.key);
  }
  return keys.sort();
}

async function made(vault: VaultStore, clock: Clock) {
  const owner = ofVault(vault, clock);
  const people = new Map<string, Device>(
    NAMES.map((name) => [name, device(clock)]),
  );
  const { draft, invite } = await beginCircle(owner, {
    label: LABEL,
    collection: "Emergency",
    recovers: true,
  });
  const ids: string[] = [];
  for (const [name, person] of people) {
    const { enrollment } = await acceptInvitation(person, {
      packet: invite,
      name,
      keyLabels: ["Security key"],
    });
    ids.push(
      (
        await acceptGuardian(owner, draft.circleId, {
          packet: enrollment,
          custodyDomain: `home-${name}`,
          contactRef: null,
        })
      ).id,
    );
  }
  const seen = await reached(() =>
    createFromDraft(owner, draft.circleId, {
      rule: oneGroup(ids, 2),
      timing: DEFAULT_TIMING,
      payload: PAYLOAD,
    }),
  );
  return {
    owner,
    people,
    circleId: draft.circleId,
    dealt: seen.value,
    seen,
  };
}

describe("what an owner dealt, at rest", () => {
  it("writes nothing readable: not a key, a name, a circle, a packet or a file's name", async () => {
    live = await openVault();
    const clock = new Clock();
    const { owner, circleId, dealt, seen } = await made(live, clock);
    expect(dealt.kept).toBe(true);
    const [record] = await owner.records.owned();
    const ownerKey = toB64url(record?.ownerSecretKey ?? new Uint8Array());
    const welcome = dealt.welcomes[0]?.packet ?? "";
    const file = dealt.bundleFile ?? "";
    expect(welcome.length).toBeGreaterThan(200);
    expect(file.length).toBeGreaterThan(200);

    expect(seen.values.length).toBeGreaterThan(0);
    const needles = [
      ownerKey,
      LABEL,
      circleId,
      "dealt",
      "osq1.",
      "ownerSecretKey",
      welcome.slice(40, 120),
      file.slice(40, 120),
      ...NAMES.map((name) => `${name}'s`),
    ];
    for (const text of seen.values) {
      for (const needle of needles) expect(text).not.toContain(needle);
    }
    for (const name of seen.names) {
      for (const needle of ["dealt", circleId, LABEL, "welcome"]) {
        expect(name).not.toContain(needle);
      }
    }

    // A file the storage holds is a sealed envelope and a hash for a name.
    const tomb = live.activeTomb();
    const paths = await listDir(tomb, PENDING_DIR);
    expect(paths.length).toBeGreaterThanOrEqual(2);
    for (const path of paths) {
      expect(path.slice(PENDING_DIR.length + 1)).toMatch(/^[0-9a-f]{64}$/);
      const raw = kvGet(tombFileKey(tomb, path)) ?? "{}";
      expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["ctB64", "ivB64"]);
    }
    // The document is there, under its key, inside the seal and nowhere else.
    expect(await restingKeys(live)).toContain(`dealt:${circleId}`);
  });

  it("is still there when the vault is closed and opened again, and works from there", async () => {
    live = await openVault();
    const clock = new Clock();
    const { circleId, dealt, people } = await made(live, clock);

    live = await reopenVault(live);
    const later = ofVault(live, clock);
    const back = await readDealt(later, circleId);
    expect(back).toEqual(dealt);
    expect(back?.bundleFile).toBe(dealt.bundleFile);

    // Only Ada has her packet before the page is closed again.
    const [ada, ...rest] = back?.welcomes ?? [];
    const first = await takeWelcome(
      people.get("Ada") ?? device(clock),
      ada?.packet ?? "",
    );
    await recordReceipt(later, circleId, first.receipt ?? "");
    live = await reopenVault(live);
    const again = ofVault(live, clock);
    const waiting = await readDealt(again, circleId);
    expect(waiting?.welcomes).toEqual(dealt.welcomes);
    expect((await custodyStatus(again, circleId)).held).toHaveLength(1);

    // Ben and Cy take theirs from what was kept; with the last receipt it goes.
    for (const handout of rest) {
      const taken = await takeWelcome(
        people.get(handout.name) ?? device(clock),
        handout.packet,
      );
      await recordReceipt(again, circleId, taken.receipt ?? "");
    }
    expect((await custodyStatus(again, circleId)).armed).toBe(true);
    expect(await readDealt(again, circleId)).toBeNull();
    expect(await restingKeys(live)).not.toContain(`dealt:${circleId}`);
    expect(
      (await restingKeys(live)).some((key) => key.startsWith("dealt:")),
    ).toBe(false);

    live = await reopenVault(live);
    expect(await readDealt(ofVault(live, clock), circleId)).toBeNull();
  }, 30_000);

  it("is gone from the vault's files when the circle is retired", async () => {
    live = await openVault();
    const clock = new Clock();
    const { owner, circleId } = await made(live, clock);
    expect(
      (await restingKeys(live)).some((key) => key.startsWith("dealt:")),
    ).toBe(true);
    await retireCircle(owner, circleId);
    await vfsFlush();
    expect(
      (await restingKeys(live)).some((key) => key.startsWith("dealt:")),
    ).toBe(false);
    live = await reopenVault(live);
    expect(await readDealt(ofVault(live, clock), circleId)).toBeNull();
  });
});
