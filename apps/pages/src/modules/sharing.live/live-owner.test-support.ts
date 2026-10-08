/** Genuine owner/crypto fixtures. Only declared browser storage and network boundaries are doubled. */
import { webcrypto } from "node:crypto";
import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { configureHost } from "@opensesame/app-core/host.js";
import { kvFlush } from "@opensesame/app-core/lib/kv.js";
import { captureHostAuthority } from "@opensesame/app-core/lib/live/host-authority.js";
import { transportReadiness } from "@opensesame/app-core/lib/live/transport-readiness.js";
import {
  TRANSPORT_PATH,
  readLiveTransport,
  writeLiveTransport,
} from "@opensesame/app-core/lib/live/transport-store.js";
import {
  DIRECT_TRANSPORT,
  type LiveTransport,
  transportFileText,
} from "@opensesame/app-core/lib/live/transport.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { PERSONAL_TOMB, writeFile } from "@opensesame/app-core/lib/vfs.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import type { VaultItem } from "@opensesame/vault-core";
import { waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";

export async function genuineLiveOwner(
  items: readonly VaultItem[] = [],
): Promise<() => Promise<void>> {
  vi.stubGlobal("crypto", webcrypto);
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  for (const item of items) await vaultStore.saveItem(item);
  await writeLiveTransport(PERSONAL_TOMB, DIRECT_TRANSPORT);
  return async () => {
    await waitFor(() => expect(transportReadiness().pending).toBe(0));
    vaultStore.lock();
    await kvFlush();
    vi.unstubAllGlobals();
    configureHost(createTestHost());
  };
}

/** Deliberate fixture input is installed through actual encrypted VFS I/O; observations are read back. */
export function genuineProfilePorts(input: {
  current: () => LiveTransport;
  keep: (next: LiveTransport) => void;
  refusal?: () => Error | null;
}) {
  let installed: LiveTransport | undefined;
  let writing = 0;
  return {
    tomb: () => vaultStore.activeTomb(),
    read: async (tomb: string) => {
      const check = captureHostAuthority(vaultStore.pinContinuation());
      const refused = input.refusal?.();
      if (refused) throw refused;
      const wanted = input.current();
      if (writing === 0 && wanted !== installed) {
        installed = wanted;
        await writeFile(
          tomb,
          TRANSPORT_PATH,
          new TextEncoder().encode(transportFileText(wanted)),
        );
        check();
      }
      const actual = await readLiveTransport(tomb);
      check();
      return actual;
    },
    write: async (tomb: string, next: LiveTransport, check: () => void) => {
      writing += 1;
      try {
        check();
        await writeLiveTransport(tomb, next, check);
        check();
        const actual = await readLiveTransport(tomb);
        check();
        installed = actual;
        input.keep(actual);
      } finally {
        writing -= 1;
      }
    },
  };
}
