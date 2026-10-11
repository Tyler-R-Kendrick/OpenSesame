/**
 * A circle that was begun and not made stays where a closed screen can find
 * it, and can be let go of; an invitation round for a circle that exists is
 * not mistaken for one.
 */
import { describe, expect, it } from "vitest";
import { Clock, armedCircle, device } from "./harness.test-support.js";
import {
  acceptGuardian,
  acceptInvitation,
  beginCircle,
  discardDraft,
  inviteMore,
  readDraft,
  unfinishedCircle,
} from "./index.js";

describe("a circle begun and not yet made", () => {
  it("is found again with the people who have answered, and is gone once discarded", async () => {
    const clock = new Clock();
    const owner = device(clock);
    expect(await unfinishedCircle(owner)).toBeNull();

    const { draft, invite } = await beginCircle(owner, {
      label: "Family",
      collection: "Everything",
      recovers: true,
    });
    const ada = device(clock);
    const { enrollment } = await acceptInvitation(ada, {
      packet: invite,
      name: "Ada",
      keyLabels: ["Security key"],
    });
    await acceptGuardian(owner, draft.circleId, {
      packet: enrollment,
      custodyDomain: "home-ada",
      contactRef: null,
    });

    const found = await unfinishedCircle(owner);
    expect(found?.circleId).toBe(draft.circleId);
    expect(found?.label).toBe("Family");
    expect(found?.guardians.map((g) => g.name)).toEqual(["Ada"]);

    await discardDraft(owner, draft.circleId);
    expect(await unfinishedCircle(owner)).toBeNull();
    expect(await readDraft(owner, draft.circleId)).toBeNull();
  });

  it("does not take an invitation round for a circle that exists for one that was never made", async () => {
    const armed = await armedCircle(new Clock());
    await inviteMore(armed.owner, armed.circleId);
    expect(await readDraft(armed.owner, armed.circleId)).not.toBeNull();
    expect(await unfinishedCircle(armed.owner)).toBeNull();

    await discardDraft(armed.owner, armed.circleId);
    expect(await readDraft(armed.owner, armed.circleId)).toBeNull();
    // The circle itself is untouched.
    expect(await armed.owner.records.owned()).toHaveLength(1);
  });

  it("passes over a saved draft that no longer reads rather than failing the screen", async () => {
    const clock = new Clock();
    const owner = device(clock);
    await owner.pending.write("owner-draft:broken", { v: 2 });
    expect(await unfinishedCircle(owner)).toBeNull();
    const { draft } = await beginCircle(owner, {
      label: "Family",
      collection: "Everything",
      recovers: false,
    });
    expect((await unfinishedCircle(owner))?.circleId).toBe(draft.circleId);
  });
});
