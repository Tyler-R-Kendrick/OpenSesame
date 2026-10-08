// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import {
  holdGenuineRead,
  persistentBrowserOwner,
} from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { configureHost } from "@opensesame/app-core/host.js";
import { kvFileName, kvFlush } from "@opensesame/app-core/lib/kv.js";
import {
  TRANSPORT_PATH,
  readLiveTransport,
  writeLiveTransport,
} from "@opensesame/app-core/lib/live/transport-store.js";
import { DIRECT_TRANSPORT } from "@opensesame/app-core/lib/live/transport.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { PERSONAL_TOMB, tombFileKey } from "@opensesame/app-core/lib/vfs.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { LiveRoutesPanel } from "./LiveRoutesPanel.js";
import { transportSeams } from "./live-transport-hooks.js";

it("commits each owner's relay choice captured before a held sealed-profile read", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const owner = await persistentBrowserOwner();
  const original = { ...transportSeams };
  const commits: boolean[] = [];
  let held: ReturnType<typeof holdGenuineRead> | undefined;
  try {
    await vaultStore.unlock(owner.password);
    await writeLiveTransport(PERSONAL_TOMB, {
      ...DIRECT_TRANSPORT,
      ice: [
        {
          urls: ["turn:127.0.0.1:3478?transport=tcp"],
          username: "fixture",
          credential: "controlled-fixture",
        },
      ],
    });
    const panel = render(<LiveRoutesPanel />);
    const checkbox = await panel.findByRole("checkbox", {
      name: "Relay only, through TURN",
    });
    transportSeams.write = async (tomb, value) => {
      await writeLiveTransport(tomb, value);
      commits.push((await readLiveTransport(tomb)).relay);
    };
    held = holdGenuineRead(
      owner.root,
      kvFileName(tombFileKey(PERSONAL_TOMB, TRANSPORT_PATH)),
    );
    fireEvent.click(checkbox);
    await held.started;
    expect(checkbox).toHaveProperty("checked", true);
    // A second genuine checkbox gesture changes the mutable DOM before the first read resumes.
    fireEvent.click(checkbox);
    expect(checkbox).toHaveProperty("checked", false);
    held.release();
    await waitFor(() => expect(commits).toHaveLength(2));
    expect(commits).toEqual([true, false]);
    expect((await readLiveTransport(PERSONAL_TOMB)).relay).toBe(false);
  } finally {
    held?.release();
    cleanup();
    Object.assign(transportSeams, original);
    vaultStore.lock();
    await kvFlush();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    configureHost(createTestHost());
  }
}, 20_000);
