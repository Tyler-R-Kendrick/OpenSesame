/**
 * What an owner hands out is kept until it has been taken: a screen closed
 * mid-deal does not strand the contacts who have not yet been given their
 * packet, and nothing is left lying about once it has done its work.
 */
import { type JsonObject, isJsonObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { toB64url } from "../bytes.js";
import { PAYLOAD } from "../world.test-support.js";
import {
  Clock,
  type Device,
  armedCircle,
  device,
  oneGroup,
  who,
} from "./harness.test-support.js";
import {
  DEFAULT_TIMING,
  type Dealt,
  type Handout,
  acceptGuardian,
  acceptInvitation,
  beginCircle,
  createFromDraft,
  custodyStatus,
  forgetDealt,
  readDealt,
  recordReceipt,
  reissue,
  retireCircle,
  takeWelcome,
} from "./index.js";

const NAMES = ["Ada", "Ben", "Cy"] as const;
const key = (circleId: string) => `dealt:${circleId}`;

/** A circle made and not yet armed: the packets are dealt and no one has taken theirs. */
async function dealtCircle(clock: Clock, recovers = true) {
  const owner = device(clock);
  const people = new Map(NAMES.map((name) => [name, device(clock)]));
  const { draft, invite } = await beginCircle(owner, {
    label: "Family",
    collection: "Emergency",
    recovers,
  });
  const ids: string[] = [];
  for (const [name, person] of people) {
    const { enrollment } = await acceptInvitation(person, {
      packet: invite,
      name,
      keyLabels: ["Security key"],
    });
    const guardian = await acceptGuardian(owner, draft.circleId, {
      packet: enrollment,
      custodyDomain: `home-${name}`,
      contactRef: null,
    });
    ids.push(guardian.id);
  }
  const dealt = await createFromDraft(owner, draft.circleId, {
    rule: oneGroup(ids, 2),
    timing: DEFAULT_TIMING,
    payload: recovers ? PAYLOAD : undefined,
  });
  return { owner, people, circleId: draft.circleId, ids, dealt };
}

/** The kept document, as stored. */
async function stored(owner: Device, circleId: string): Promise<JsonObject> {
  const doc = await owner.pending.read(key(circleId));
  if (!isJsonObject(doc)) throw new Error("nothing is kept");
  return doc;
}

async function take(person: Device, packet: string): Promise<string> {
  const taken = await takeWelcome(person, packet);
  return taken.receipt ?? "";
}

describe("what a circle was dealt", () => {
  it("is kept when the circle is made, and read back as it was", async () => {
    const { owner, circleId, dealt } = await dealtCircle(new Clock());
    expect(dealt.kept).toBe(true);
    expect(await owner.pending.list("dealt:")).toEqual([key(circleId)]);
    const again = await readDealt(owner, circleId);
    expect(again).toEqual(dealt);
    expect(again?.welcomes.map((w) => w.name)).toEqual([...NAMES]);
    expect(again?.bundleFile).toBe(dealt.bundleFile);
  });

  it("holds packets, a file and nothing of the owner's: no signing key", async () => {
    const { owner, circleId } = await dealtCircle(new Clock());
    const [record] = await owner.records.owned();
    const stored = JSON.stringify(await owner.pending.read(key(circleId)));
    expect(stored).not.toContain(
      toB64url(record?.ownerSecretKey ?? new Uint8Array()),
    );
    expect(stored).not.toContain("ownerSecretKey");
    expect(Object.keys(JSON.parse(stored)).sort()).toEqual([
      "bundleFile",
      "circleId",
      "epoch",
      "notices",
      "v",
      "welcomes",
    ]);
  });

  it("is still there, whole, until the last contact's receipt is in, and is gone with it", async () => {
    const { owner, people, circleId, dealt } = await dealtCircle(new Clock());
    const taken: string[] = [];
    for (const [index, name] of NAMES.entries()) {
      // Each is handed their packet from what was kept, as a reopened screen does.
      const kept = await readDealt(owner, circleId);
      expect(kept?.welcomes).toEqual(dealt.welcomes);
      const packet = kept?.welcomes[index]?.packet ?? "";
      const receipt = await take(
        people.get(name) ?? device(new Clock()),
        packet,
      );
      taken.push(receipt);
      const status = await recordReceipt(owner, circleId, receipt);
      expect(status.held).toHaveLength(index + 1);
      if (index < NAMES.length - 1) {
        expect(await readDealt(owner, circleId)).not.toBeNull();
      }
    }
    expect(await custodyStatus(owner, circleId)).toMatchObject({ armed: true });
    expect(await readDealt(owner, circleId)).toBeNull();
    expect(await owner.pending.list("dealt:")).toEqual([]);
  });

  it("is kept for a circle of approvals only, which has no receipt to end it, until it is changed or retired", async () => {
    const { owner, circleId, dealt, ids } = await dealtCircle(
      new Clock(),
      false,
    );
    expect(dealt.bundleFile).toBeNull();
    expect(dealt.kept).toBe(true);
    expect((await readDealt(owner, circleId))?.welcomes).toHaveLength(3);
    // A new epoch replaces it.
    const next = await reissue(owner, circleId, {
      drop: [ids[2] ?? ""],
      rule: oneGroup(ids.slice(0, 2), 2),
    });
    expect(next.kept).toBe(true);
    const kept = await readDealt(owner, circleId);
    expect(kept?.welcomes.map((w) => w.name)).toEqual(["Ada", "Ben"]);
    expect(kept?.notices.map((w) => w.name)).toEqual(["Cy"]);
    expect(kept?.bundleFile).toBeNull();
    await retireCircle(owner, circleId);
    expect(await owner.pending.list("dealt:")).toEqual([]);
  });
});

/** Who a set of handouts is for. */
const whoFor = (list: readonly Handout[] | undefined) =>
  (list ?? []).map((handout) => handout.name);

/** The packet dealt to `name`. */
const packetFor = (dealt: Dealt | null, name: string) =>
  dealt?.welcomes.find((handout) => handout.name === name)?.packet ?? "";

describe("a new epoch", () => {
  it("supersedes the packets of the one before, and keeps its own notices and file", async () => {
    const clock = new Clock();
    const armed = await armedCircle(clock);
    // Armed: nothing waits.
    expect(await readDealt(armed.owner, armed.circleId)).toBeNull();
    const [ada = "", ben = "", cy = ""] = armed.guardianIds;
    const rule = oneGroup([ada, ben], 2);
    clock.at(3600);
    const first = await reissue(armed.owner, armed.circleId, {
      drop: [cy],
      rule,
      payload: PAYLOAD,
    });
    expect(first.kept).toBe(true);
    const kept = await readDealt(armed.owner, armed.circleId);
    expect(whoFor(kept?.welcomes)).toEqual(["Ada", "Ben"]);
    expect(whoFor(kept?.notices)).toEqual(["Cy"]);
    expect(kept?.bundleFile).toBe(first.bundleFile);

    // Changed again before anyone took theirs: only the latest is kept.
    clock.at(7200);
    const second = await reissue(armed.owner, armed.circleId, {
      drop: [],
      rule,
      payload: PAYLOAD,
    });
    const latest = await readDealt(armed.owner, armed.circleId);
    expect(latest?.welcomes).toEqual(second.welcomes);
    expect(latest?.notices).toEqual([]);
    expect(latest?.welcomes).not.toEqual(first.welcomes);
    expect(await armed.owner.pending.list("dealt:")).toEqual([
      key(armed.circleId),
    ]);

    // The latest are the ones that work.
    for (const name of ["Ada", "Ben"]) {
      const receipt = await take(who(armed, name), packetFor(latest, name));
      await recordReceipt(armed.owner, armed.circleId, receipt);
    }
    expect(await readDealt(armed.owner, armed.circleId)).toBeNull();
  });
});

describe("retiring a circle", () => {
  it("forgets what was dealt for it", async () => {
    const { owner, circleId } = await dealtCircle(new Clock());
    expect(await owner.pending.list("dealt:")).toHaveLength(1);
    await retireCircle(owner, circleId);
    expect(await owner.pending.list("dealt:")).toEqual([]);
    expect(await readDealt(owner, circleId)).toBeNull();
  });

  it("forgets only its own", async () => {
    const clock = new Clock();
    const one = await dealtCircle(clock);
    const other = await dealtCircle(clock);
    await forgetDealt(one.owner, one.circleId);
    expect(await readDealt(one.owner, one.circleId)).toBeNull();
    expect(await readDealt(other.owner, other.circleId)).not.toBeNull();
  });
});

describe("a kept document that cannot be used", () => {
  it("is not used when it is for an epoch the circle has left, or a circle that is gone", async () => {
    const clock = new Clock();
    const { owner, circleId } = await dealtCircle(clock);
    const doc = await stored(owner, circleId);
    await owner.pending.write(key(circleId), { ...doc, epoch: 2 });
    expect(await readDealt(owner, circleId)).toBeNull();
    expect(await owner.pending.read(key(circleId))).toBeUndefined();

    await owner.pending.write(key(circleId), doc);
    expect(await readDealt(owner, circleId)).not.toBeNull();
    await owner.records.removeOwned(circleId);
    expect(await readDealt(owner, circleId)).toBeNull();
    expect(await owner.pending.read(key(circleId))).toBeUndefined();
  });

  it("is removed, not read, when it does not hold what it says", async () => {
    const clock = new Clock();
    const { owner, circleId, dealt } = await dealtCircle(clock);
    const other = await dealtCircle(clock);
    const doc = await stored(owner, circleId);
    const welcome = dealt.welcomes[0];
    if (!welcome) throw new Error("no welcome");
    const strangers = other.dealt.welcomes[0]?.packet ?? "";
    const broken: JsonObject[] = [
      { ...doc, extra: 1 },
      { ...doc, circleId: "someone-else" },
      { ...doc, welcomes: [] },
      { ...doc, welcomes: [{ ...welcome, packet: "osq1.nonsense" }] },
      // A packet of another circle filed under this one.
      { ...doc, welcomes: [{ ...welcome, packet: strangers }] },
      {
        ...doc,
        welcomes: [{ ...welcome, packet: dealt.notices[0]?.packet ?? "x" }],
      },
      { ...doc, notices: [{ ...welcome }] },
      { ...doc, bundleFile: "{}" },
      { ...doc, bundleFile: "not json" },
      { ...doc, welcomes: [{ ...welcome, name: "" }] },
      { ...doc, v: 2 },
    ];
    for (const bad of broken) {
      await owner.pending.write(key(circleId), JSON.parse(JSON.stringify(bad)));
      expect(await readDealt(owner, circleId)).toBeNull();
      expect(await owner.pending.read(key(circleId))).toBeUndefined();
    }
  });

  it("is not hidden by a store that fails: that is not a document that does not read", async () => {
    const { owner, circleId } = await dealtCircle(new Clock());
    const failing = {
      ...owner,
      pending: {
        ...owner.pending,
        read: async () => {
          throw new Error("the vault is locked");
        },
      },
    };
    await expect(readDealt(failing, circleId)).rejects.toThrow("locked");
  });
});

describe("when the packets cannot be kept", () => {
  function refusing(owner: Device): Device {
    return {
      ...owner,
      pending: {
        ...owner.pending,
        write: async (k, value) => {
          if (k.startsWith("dealt:")) throw new Error("too large");
          return owner.pending.write(k, value);
        },
      },
    };
  }

  it("makes the circle all the same and says they were not kept", async () => {
    const clock = new Clock();
    const base = await dealtCircle(clock);
    // A second circle, on a store that will not keep them.
    const owner = device(clock);
    const failing = refusing(owner);
    const { draft, invite } = await beginCircle(failing, {
      label: "Family",
      collection: "Emergency",
      recovers: true,
    });
    const ada = device(clock);
    const { enrollment } = await acceptInvitation(ada, {
      packet: invite,
      name: "Ada",
      keyLabels: ["Security key"],
    });
    const guardian = await acceptGuardian(failing, draft.circleId, {
      packet: enrollment,
      custodyDomain: "home-ada",
      contactRef: null,
    });
    const dealt = await createFromDraft(failing, draft.circleId, {
      rule: oneGroup([guardian.id], 1),
      timing: DEFAULT_TIMING,
      payload: PAYLOAD,
    });
    expect(dealt.kept).toBe(false);
    expect(dealt.welcomes).toHaveLength(1);
    expect(await owner.records.owned()).toHaveLength(1);
    expect(await readDealt(failing, draft.circleId)).toBeNull();
    expect(base.dealt.kept).toBe(true);
  });

  it("does not leave the packets of an earlier epoch to be mistaken for the new ones", async () => {
    const clock = new Clock();
    const { owner, circleId, ids } = await dealtCircle(clock);
    const failing = refusing(owner);
    clock.at(3600);
    const next = await reissue(failing, circleId, {
      drop: [],
      rule: oneGroup(ids, 2),
      payload: PAYLOAD,
    });
    expect(next.kept).toBe(false);
    expect(await owner.pending.list("dealt:")).toEqual([]);
    expect(await readDealt(owner, circleId)).toBeNull();
  });
});
