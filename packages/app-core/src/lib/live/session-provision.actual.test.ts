import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { ensureOwnerPerson } from "../local-directory-bootstrap.js";
import { readLocalDirectory } from "../local-directory.js";
import { listLocalShares } from "../local-share-grants.js";
import { vaultStore } from "../vault/store.js";
import { lockAllTombs } from "../vfs.js";
import { provisionLiveSessionGuest } from "./session-provision.js";

const PIN = "48291037";

beforeEach(async () => {
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
  lockAllTombs();
  await vaultStore.createWithPin(PIN);
});

afterEach(() => {
  vaultStore.lock();
  lockAllTombs();
  vi.unstubAllGlobals();
});

it("provisions against a real open vault", async () => {
  const tomb = vaultStore.activeTomb();
  await ensureOwnerPerson(tomb, "Owner");
  const item = createItem("secret", "Shared account");
  item.value = "SHARED-SECRET";
  await vaultStore.saveItem(item);
  await provisionLiveSessionGuest({
    tomb,
    hostId: crypto.randomUUID(),
    guest: { key: "seat", name: "Ada", note: "", kind: "person" },
    scope: { kind: "items", ids: [item.id] },
    policy: "use",
    minutes: 60,
    audience: "anyone",
    peopleIds: [],
    items: vaultStore.getSnapshot().items,
  });
  const directory = await readLocalDirectory(tomb);
  expect(
    directory.entries.some(
      (entry) => entry.name === "Ada" && entry.kind === "person",
    ),
  ).toBe(true);
  expect(await listLocalShares(tomb)).toContainEqual(
    expect.objectContaining({ resourceId: item.id, policy: "use" }),
  );
});
