import { expect, it } from "vitest";
import { webLocksDouble } from "./web-locks-double.js";
function gate() {
  let release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  return { held, release };
}
it("delivers named exclusive grants through both overloads and releases before completion", async () => {
  const locks = webLocksDouble();
  expect(await locks.request("owner", (lock) => lock)).toEqual({
    name: "owner",
    mode: "exclusive",
  });
  expect(
    await locks.request("owner", { ifAvailable: true }, (lock) => lock),
  ).toEqual({ name: "owner", mode: "exclusive" });
  expect(locks.peak()).toBe(1);
});
it("permits shared holders together and holds an exclusive successor until both retire", async () => {
  const locks = webLocksDouble();
  const first = gate();
  const second = gate();
  let exclusive = false;
  const a = locks.request("owner", { mode: "shared" }, async (lock) => {
    expect(lock?.mode).toBe("shared");
    await first.held;
  });
  const b = locks.request("owner", { mode: "shared" }, async () => second.held);
  const c = locks.request("owner", { mode: "exclusive" }, () => {
    exclusive = true;
  });
  expect(locks.peak()).toBe(2);
  first.release();
  await a;
  expect(exclusive).toBe(false);
  second.release();
  await Promise.all([b, c]);
  expect(exclusive).toBe(true);
});
it("delivers null for unavailable grants and withdraws an aborted queued callback", async () => {
  const locks = webLocksDouble();
  const held = gate();
  const first = locks.request("owner", () => held.held);
  expect(
    await locks.request("owner", { ifAvailable: true }, (lock) => lock),
  ).toBeNull();
  const controller = new AbortController();
  let ran = false;
  const queued = locks.request("owner", { signal: controller.signal }, () => {
    ran = true;
  });
  const refusal = expect(queued).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await refusal;
  held.release();
  await first;
  expect(ran).toBe(false);
});
