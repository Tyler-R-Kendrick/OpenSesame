import { expect, it } from "vitest";
import { enqueueTombWrite, withTombWriteTurn } from "./vfs-write-order.js";

function gate() {
  let release = () => {};
  let announce = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  return { release, announce, held, entered };
}

it("serializes an entire owned turn while allowing its awaited nested effects", async () => {
  const delivery = gate();
  const events: string[] = [];
  const rotation = withTombWriteTurn("ordering-only", async (turn) => {
    events.push("prepare");
    await enqueueTombWrite(
      "ordering-only",
      async () => {
        events.push("publish");
      },
      turn,
    );
    delivery.announce();
    await delivery.held;
    events.push("adopt");
  });
  await delivery.entered;
  const peer = enqueueTombWrite("ordering-only", async () => {
    events.push("peer");
  });
  try {
    await Promise.resolve();
    expect(events).toEqual(["prepare", "publish"]);
  } finally {
    delivery.release();
    await Promise.all([rotation, peer]);
  }
  expect(events).toEqual(["prepare", "publish", "adopt", "peer"]);
});

it("rejects forged, foreign and retired turns before invoking a nested effect", async () => {
  let calls = 0;
  const effect = async () => {
    calls += 1;
  };
  expect(() =>
    enqueueTombWrite("owner", effect, Object.freeze({ tomb: "owner" })),
  ).toThrow(/not active/);
  const retained = await withTombWriteTurn("owner", async (turn) => {
    expect(() => enqueueTombWrite("foreign", effect, turn)).toThrow(
      /not active/,
    );
    return turn;
  });
  expect(() => enqueueTombWrite("owner", effect, retained)).toThrow(
    /not active/,
  );
  expect(calls).toBe(0);
});
