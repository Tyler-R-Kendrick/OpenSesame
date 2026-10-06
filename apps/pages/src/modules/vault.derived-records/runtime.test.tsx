/** @vitest-environment jsdom */
import { packSeams } from "@opensesame/app-core/lib/type-packs/installer.js";
import {
  getPackSnapshot,
  isBusy,
  resetPackStateForTests,
  statusOf,
} from "@opensesame/app-core/lib/type-packs/state.js";
import { dropPack, packEntries } from "@opensesame/vault-item-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;
const original = { ...packSeams };

beforeEach(() => {
  // Packs arrive on demand: the suite starts with every one of them off.
  for (const entry of packEntries()) dropPack(entry.id);
  resetPackStateForTests();
});

afterEach(() => {
  Object.assign(packSeams, original);
});

describe("vault.derived-records runtime", () => {
  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
  });

  it("registers the twenty-three derived kinds and nothing else (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "vault.derived-records",
      kinds: ["item-kind"],
      count: 23,
    });
  });

  it("registers the kinds before any definition has arrived", async () => {
    // A fetch that never answers: activation must not wait on it.
    packSeams.fetchText = () => new Promise(() => undefined);
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const kinds = t.entries("item-kind");
    expect(kinds).toHaveLength(23);
    const named = Object.fromEntries(
      kinds.map((k) => [k.kind, [k.label, k.segment, k.order]]),
    );
    expect(named.account).toEqual(["Account", "accounts", 0]);
    expect(named.card).toEqual(["Card", "cards", 30]);
    expect(named.note).toEqual(["Secure note", "notes", 60]);
    expect(named.wifi?.[1]).toBe("wi-fi-networks");
    await handle.dispose();
  });

  it("queues the definitions behind the kinds, as a document's need and not a choice", async () => {
    const yielded = vi.fn(() => Promise.resolve());
    packSeams.yieldToMain = yielded;
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(getPackSnapshot().pending).toBeGreaterThan(0);
    expect(isBusy(statusOf("account").phase)).toBe(true);
    await vi.waitFor(() => expect(getPackSnapshot().pending).toBe(0));
    expect(statusOf("account").phase).toBe("on");
    expect(statusOf("wifi").phase).toBe("on");
    await handle.dispose();
  });
});
