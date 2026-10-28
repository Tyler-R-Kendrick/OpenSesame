import path from "node:path";
import { expect } from "@playwright/test";
import { pairByLink } from "./tailnet-devices-stack.mjs";
import { listTutorials } from "./tutorial-walk.mjs";

/** Pair the real daemon and walk its Add lesson without mutating the tailnet. */
export async function pairTutorialTailnet({
  page,
  base,
  tailnet,
  width,
  out,
  guarded,
  walkOne,
  check,
  say,
}) {
  say("  pairing the real tailnet daemon");
  await pairByLink(
    page,
    base,
    tailnet.pairLink("manage", `Tutorials ${width}`),
  );
  const devices = page.getByRole("region", { name: "Tailnet devices" });
  await expect(devices.getByRole("heading", { level: 3 })).toHaveCount(4, {
    timeout: 20000,
  });
  await expect(
    devices.getByRole("button", { name: "Add a device", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(out, `${width}-tailnet-devices-paired.png`),
  });
  await guarded(page, "paired Add tutorial", async () => {
    const before = tailnet.stub.tailnet.calls.length;
    const entries = await listTutorials(page);
    const entry = entries.find(
      (item) => item.id === "identity.tailnet.devices.add",
    );
    expect(entry).toBeTruthy();
    await walkOne(page, entry, { phone: width < 600, width, reset: false });
    const mutations = tailnet.stub.tailnet.calls
      .slice(before)
      .filter((call) => call.method !== "GET")
      .map(({ method, path }) => ({ method, path }));
    expect(mutations).toEqual([]);
    check(
      true,
      "the paired Add tutorial points at the real control without changes",
    );
  });
}
