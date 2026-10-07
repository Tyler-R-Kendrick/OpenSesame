/** @vitest-environment jsdom */
import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { deferred } from "@opensesame/app-core/browser/security/management.fixture.js";
import type { LiveHost } from "@opensesame/app-core/lib/live/host.js";
import { leaveLive, liveSeams } from "@opensesame/app-core/lib/live/session.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCopySecret } from "../../lib/vault/hooks.js";
import { releaseConnectorOwner } from "../../sections/settings/connector-owner.test-support.js";
import { useLiveRequestClipboard } from "./live-copy.js";
import { clipboardFixture, makeRequest } from "./live-copy.test-support.js";

const originalSeams = { ...liveSeams };
const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
let hosted: LiveHost | null = null;
afterEach(async () => {
  cleanup();
  leaveLive();
  hosted?.end("owner");
  hosted = null;
  await releaseConnectorOwner();
  await Promise.resolve();
  Object.assign(liveSeams, originalSeams);
  vi.restoreAllMocks();
  if (originalClipboard)
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

it.each(["vault", "live"])(
  "withholds the older %s write without clearing a newer same-valued other copier",
  async (older) => {
    const owner = await persistentBrowserOwner();
    await vaultStore.unlock(owner.password);
    const { owner: liveOwner, guest, code } = await makeRequest();
    hosted = liveOwner;
    const memory = clipboardFixture();
    const vault = renderHook(() => useCopySecret());
    const live = renderHook(() => useLiveRequestClipboard(guest, code));
    const first =
      older === "vault" ? vault.result.current : live.result.current.copy;
    const second =
      older === "vault" ? live.result.current.copy : vault.result.current;
    const entered = deferred<void>();
    const held = deferred<void>();
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    vi.spyOn(navigator.clipboard, "writeText").mockImplementationOnce(
      async (value) => {
        entered.finish(undefined);
        await held.promise;
        await write(value);
      },
    );
    const pending = first(code);
    try {
      await entered.promise;
      expect(await second(code)).toBe("copied");
      held.finish(undefined);
      expect(await pending).toBe("unavailable");
      expect(memory.content).toBe(code);
      expect(memory.writes).toEqual([code, code]);
    } finally {
      held.finish(undefined);
      await pending;
    }
  },
);
