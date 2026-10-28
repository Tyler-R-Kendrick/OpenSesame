import { FakeBus, FakeNet } from "@opensesame/app-core/lib/live/live-fakes.js";
import {
  endHosting,
  liveSeams,
} from "@opensesame/app-core/lib/live/session.js";
import {
  DIRECT_TRANSPORT,
  type LiveTransport,
  type TransportRead,
} from "@opensesame/app-core/lib/live/transport.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createItem } from "@opensesame/vault-core";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { liveUiSeams } from "./live-hooks.js";
import { transportSeams } from "./live-transport-hooks.js";

const original = {
  hooks: { ...vaultHooksSeams },
  live: { ...liveSeams },
  ui: { ...liveUiSeams },
  transport: { ...transportSeams },
};
let stored: LiveTransport;
export const currentTransport = () => stored;

beforeEach(() => {
  stored = DIRECT_TRANSPORT;
  Object.assign(vaultHooksSeams, {
    useVault: () => ({
      ...vaultStore.getSnapshot(),
      status: "unlocked" as const,
      items: [createItem("account", "GitHub")],
    }),
  });
  Object.assign(liveSeams, { items: () => [createItem("account", "GitHub")] });
  Object.assign(liveUiSeams, {
    transport: new FakeNet().transports(),
    carriers: new FakeBus().factory(),
  });
  Object.assign(transportSeams, {
    tomb: () => "personal",
    read: async () => stored,
    edit: async (
      _tomb: string,
      apply: (current: LiveTransport) => TransportRead,
    ) => {
      const next = apply(stored);
      if (next.ok) stored = next.transport;
      return next;
    },
  });
});

afterEach(() => {
  endHosting();
  cleanup();
  Object.assign(vaultHooksSeams, original.hooks);
  Object.assign(liveSeams, original.live);
  Object.assign(liveUiSeams, original.ui);
  Object.assign(transportSeams, original.transport);
});

export const type = (
  where: ReturnType<typeof within>,
  label: string,
  value: string,
) => fireEvent.change(where.getByLabelText(label), { target: { value } });

/** Hold the real form's first persistence turn while the person edits again. */
export function holdNextWrite() {
  const originalEdit = transportSeams.edit;
  let release!: () => void;
  let settled!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrote = new Promise<void>((resolve) => {
    settled = resolve;
  });
  let first = true;
  transportSeams.edit = async (tomb, apply) => {
    if (first) {
      first = false;
      await waiting;
      const result = await originalEdit(tomb, apply);
      settled();
      return result;
    }
    return originalEdit(tomb, apply);
  };
  return async () => {
    await act(async () => {
      release();
      await wrote;
    });
  };
}
