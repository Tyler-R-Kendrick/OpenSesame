/**
 * The real desk against the real adapters, on one open vault: an owner makes a
 * circle and arms it from custody receipts, a guardian agrees and takes a
 * share, and each is still there after the vault is closed and opened again.
 * The other people are the desk's own in-memory devices; what passes between
 * them is a packet, as it would be pasted. Nothing here holds the whole
 * ceremony: one vault cannot be several people, so the people not under test
 * stand elsewhere.
 */
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
  readDraft,
  recordReceipt,
  takeWelcome,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  GUARDIAN_SHARE_TYPE,
  TRUSTED_CIRCLE_TYPE,
} from "@opensesame/app-core/lib/quorum/records.js";
import {
  KeyRing,
  ORIGIN,
  PAYLOAD,
  RP_ID,
} from "@opensesame/app-core/lib/quorum/world.test-support.js";
import type { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { vfsSeams } from "@opensesame/app-core/lib/vfs.js";
import type { TypedItem } from "@opensesame/vault-core";
import { afterEach, describe, expect, it } from "vitest";
import { tombPendingStore } from "./pending-store.js";
import { vaultRecordStore } from "./vault-records.js";
import {
  closeVault,
  openVault,
  reopenVault,
} from "./vault-records.test-support.js";

/** The vault the test has open now, so a failed test still closes it. */
let live: VaultStore | null = null;

async function begin(): Promise<VaultStore> {
  live = await openVault();
  return live;
}

async function restart(store: VaultStore): Promise<VaultStore> {
  live = await reopenVault(store);
  return live;
}

afterEach(async () => {
  if (live) await closeVault(live);
  live = null;
});

/** A person's page whose records and ceremonies in flight are this vault's. */
function ofVault(
  vault: VaultStore,
  clock: Clock,
  ring: KeyRing = new KeyRing(1),
): DeskPorts {
  return {
    now: clock.date,
    origin: ORIGIN,
    rpId: RP_ID,
    ceremony: ring.ceremony(),
    pending: tombPendingStore(vault.activeTomb()),
    records: vaultRecordStore(vault),
    tomb: vault.activeTomb(),
  };
}

function typedItems(vault: VaultStore, typeId: string): TypedItem[] {
  return vault
    .getSnapshot()
    .items.filter(
      (item): item is TypedItem =>
        item.kind === "typed" && item.typeId === typeId,
    );
}

/** Everything the VFS is asked to write while `run` goes, as it reaches storage. */
async function writtenDuring(run: () => Promise<void>): Promise<string[]> {
  const written: string[] = [];
  const original = vfsSeams.writeRaw;
  vfsSeams.writeRaw = (key, value, vaultKey) => {
    written.push(value);
    return original(key, value, vaultKey);
  };
  try {
    await run();
  } finally {
    vfsSeams.writeRaw = original;
  }
  return written;
}

const NAMES = ["Ada", "Ben", "Cy"] as const;

describe("an owner's circle through the real adapters", () => {
  it("is made on the vault, armed by its receipts, and survives closing the vault", async () => {
    let store = await begin();
    const clock = new Clock();
    const owner = ofVault(store, clock);
    const people = new Map<string, Device>(
      NAMES.map((name) => [name, device(clock)]),
    );
    let ownerKey = "";
    let circleId = "";
    let welcomes: readonly { name: string; packet: string }[] = [];

    const written = await writtenDuring(async () => {
      const { draft, invite } = await beginCircle(owner, {
        label: "Family",
        collection: "Emergency",
        recovers: true,
      });
      circleId = draft.circleId;
      ownerKey = draft.ownerSecretKey ?? "";
      // The key is in a sealed file of the ceremony, and in no record yet.
      expect(ownerKey).not.toBe("");
      expect(await owner.records.owned()).toEqual([]);
      expect(await owner.pending.list("owner-draft:")).toEqual([
        `owner-draft:${circleId}`,
      ]);

      const ids: string[] = [];
      for (const [name, person] of people) {
        const { enrollment } = await acceptInvitation(person, {
          packet: invite,
          name,
          keyLabels: ["Security key"],
        });
        const guardian = await acceptGuardian(owner, circleId, {
          packet: enrollment,
          custodyDomain: `home-${name}`,
          contactRef: null,
        });
        ids.push(guardian.id);
      }
      // The ceremony is read back from the vault's file, as a reload would.
      const again = ofVault(store, clock);
      expect((await readDraft(again, circleId))?.guardians).toHaveLength(3);

      const dealt = await createFromDraft(again, circleId, {
        rule: oneGroup(ids, 2),
        timing: DEFAULT_TIMING,
        payload: PAYLOAD,
      });
      welcomes = dealt.welcomes;
      expect(dealt.bundleFile).not.toBeNull();
    });

    // The draft is spent: its key now lives in the record, a concealed value.
    expect(await owner.pending.list("owner-draft:")).toEqual([]);
    const [item] = typedItems(store, TRUSTED_CIRCLE_TYPE);
    expect(item?.values.ownerKey).toBe(ownerKey);
    expect(item?.values.status).toBe("inviting");
    expect(await custodyStatus(owner, circleId)).toMatchObject({
      held: [],
      total: 3,
      armed: false,
    });

    for (const welcome of welcomes) {
      const person = people.get(welcome.name);
      if (!person) throw new Error(`no ${welcome.name}`);
      const taken = await takeWelcome(person, welcome.packet);
      if (!taken.receipt)
        throw new Error("a circle with shares sends a receipt");
      await recordReceipt(owner, circleId, taken.receipt);
    }
    expect(await custodyStatus(owner, circleId)).toMatchObject({
      total: 3,
      armed: true,
    });
    expect(typedItems(store, TRUSTED_CIRCLE_TYPE)).toHaveLength(1);
    expect(typedItems(store, TRUSTED_CIRCLE_TYPE)[0]?.values.status).toBe(
      "armed",
    );

    // Nothing the ceremony wrote to storage held the owner's key in the clear.
    expect(written.length).toBeGreaterThan(0);
    for (const text of written) expect(text).not.toContain(ownerKey);

    // Close the vault and open it again: a second adapter over the same files.
    store = await restart(store);
    const later = ofVault(store, clock);
    const [back] = await later.records.owned();
    expect(back?.signedPolicy.policy.circleId).toBe(circleId);
    expect(back?.state).toBe("armed");
    expect(back?.ownerSecretKey).toBeInstanceOf(Uint8Array);
    const status = await custodyStatus(later, circleId);
    expect(status.armed).toBe(true);
    expect([...status.held].sort()).toHaveLength(3);
  });
});

describe("a guardian through the real adapters", () => {
  it("agrees, restarts, takes the welcome, and holds the share across another restart", async () => {
    let store = await begin();
    const clock = new Clock();
    const adaKeys = new KeyRing(1);
    const ada = ofVault(store, clock, adaKeys);
    const owner = device(clock);
    const others = [device(clock), device(clock)];

    const { draft, invite } = await beginCircle(owner, {
      label: "Family",
      collection: "Emergency",
      recovers: true,
    });
    const names = ["Ada", "Ben", "Cy"];
    const ids: string[] = [];
    let adaId = "";
    for (const [index, who] of [ada, ...others].entries()) {
      const name = names[index] ?? "";
      const { enrollment, guardianId } = await acceptInvitation(who, {
        packet: invite,
        name,
        keyLabels: ["Security key"],
      });
      if (name === "Ada") adaId = guardianId;
      const guardian = await acceptGuardian(owner, draft.circleId, {
        packet: enrollment,
        custodyDomain: `home-${name}`,
        contactRef: null,
      });
      ids.push(guardian.id);
    }
    // Her receiving key waits in a sealed file, and in no record.
    expect(await ada.pending.list("guardian-pending:")).toHaveLength(1);
    expect(await ada.records.held()).toEqual([]);
    const dealt = await createFromDraft(owner, draft.circleId, {
      rule: oneGroup(ids, 2),
      timing: DEFAULT_TIMING,
      payload: PAYLOAD,
    });
    const welcome = dealt.welcomes.find((w) => w.guardianId === adaId);
    if (!welcome) throw new Error("no welcome for Ada");

    // The page is closed before the welcome arrives; her own key comes with her.
    store = await restart(store);
    const returned = ofVault(store, clock, adaKeys);
    expect(await returned.pending.list("guardian-pending:")).toHaveLength(1);

    const taken = await takeWelcome(returned, welcome.packet);
    expect(taken.circleLabel).toBe("Family");
    if (!taken.receipt) throw new Error("a circle with shares sends a receipt");
    expect(
      (await recordReceipt(owner, draft.circleId, taken.receipt)).held,
    ).toEqual([adaId]);

    // The agreement is spent; the share is an item of the vault, wrapped.
    expect(await returned.pending.list("guardian-pending:")).toEqual([]);
    const [item] = typedItems(store, GUARDIAN_SHARE_TYPE);
    expect(item?.values.guardianId).toBe(adaId);
    expect(String(item?.values.wrapped)).not.toBe("");
    expect(typedItems(store, GUARDIAN_SHARE_TYPE)).toHaveLength(1);

    store = await restart(store);
    const [held] = await ofVault(store, clock, adaKeys).records.held();
    expect(held?.seat.guardianId).toBe(adaId);
    expect(held?.holding?.wrapped.guardianId).toBe(adaId);
    expect(held?.state).toBe("held");
    expect(held?.receivingKey).toBeInstanceOf(Uint8Array);
    expect(typedItems(store, TRUSTED_CIRCLE_TYPE)).toEqual([]);
  });

  it("holds a seat, not a share, in a circle that only approves actions", async () => {
    let store = await begin();
    const clock = new Clock();
    const ben = ofVault(store, clock);
    const owner = device(clock);
    const others = [device(clock), device(clock)];
    const { draft, invite } = await beginCircle(owner, {
      label: "Household",
      collection: "Shared logins",
      recovers: false,
    });
    const ids: string[] = [];
    let benId = "";
    for (const [index, who] of [ben, ...others].entries()) {
      const name = ["Ben", "Ada", "Cy"][index] ?? "";
      const { enrollment, guardianId } = await acceptInvitation(who, {
        packet: invite,
        name,
        keyLabels: ["Security key"],
      });
      if (name === "Ben") benId = guardianId;
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
    const dealt = await createFromDraft(owner, draft.circleId, {
      rule: oneGroup(ids, 2),
      timing: DEFAULT_TIMING,
    });
    expect(dealt.bundleFile).toBeNull();
    const welcome = dealt.welcomes.find((w) => w.guardianId === benId);
    if (!welcome) throw new Error("no welcome for Ben");

    store = await restart(store);
    const returned = ofVault(store, clock);
    const taken = await takeWelcome(returned, welcome.packet);
    expect(taken.receipt).toBeNull();

    const [held] = await returned.records.held();
    expect(held?.holding).toBeNull();
    expect(held?.seat.guardianId).toBe(benId);
    expect(typedItems(store, GUARDIAN_SHARE_TYPE)[0]?.values.wrapped).toBe("");
    expect(await returned.pending.list("guardian-pending:")).toEqual([]);
  });
});
