/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { releaseConnectorOwner } from "../settings/connector-owner.test-support.js";
import { passwordRowOwner } from "./SecretUpdate.authority.test-support.js";
import { UpdateSecretPanel } from "./SecretUpdate.js";

afterEach(async () => {
  cleanup();
  clearNotices();
  await releaseConnectorOwner();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keys each row's safe failure by item without copying either underlying browser cause", async () => {
  const f = await passwordRowOwner(false);
  const get = f.root.getFileHandle.bind(f.root);
  vi.spyOn(f.root, "getFileHandle").mockImplementation(
    async (name, options) => {
      if (name.startsWith("controlled-private-cause")) throw new Error(name);
      return get(name, options);
    },
  );
  const view = render(
    <UpdateSecretPanel
      itemId="item-a"
      label="password"
      onUpdate={async () => {
        await f.root.getFileHandle("controlled-private-cause-a");
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Update password" }));
  fireEvent.click(screen.getByRole("button", { name: "Save new value" }));
  await waitFor(() => expect(listNotices()).toHaveLength(1));
  view.unmount();
  render(
    <UpdateSecretPanel
      itemId="item-b"
      label="password"
      onUpdate={async () => {
        await f.root.getFileHandle("controlled-private-cause-b");
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Update password" }));
  fireEvent.click(screen.getByRole("button", { name: "Save new value" }));
  await waitFor(() => expect(listNotices()).toHaveLength(2));
  expect(
    listNotices()
      .map((notice) => `${notice.id} ${notice.body}`)
      .sort(),
  ).toEqual([
    "vault:secret-update:item-a:password Update failed.",
    "vault:secret-update:item-b:password Update failed.",
  ]);
  expect(JSON.stringify(listNotices())).not.toContain(
    "controlled-private-cause",
  );
  await f.recover();
  expect(listNotices()).toEqual([]);
});
