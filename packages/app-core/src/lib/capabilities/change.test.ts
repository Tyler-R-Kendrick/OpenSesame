/** @vitest-environment jsdom */
/**
 * `activatedGeneration`: the change coordinator reports a generation only
 * once its whole activation pass has finished — the predecessor revoked and
 * every approved module activated or refused. The unlocked shell waits for it
 * (apps/pages `bindings/shell-ready.ts`), so it never mounts from
 * registrations the pass is about to revoke.
 */

import type { RuntimeHandle } from "@opensesame/capability-composition";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bootPersonalLocal,
  draftFor,
  freshRealm,
  settle,
  until,
} from "./__tests__/harness.js";
import {
  activatePlan,
  activatedGeneration,
  subscribeActivated,
} from "./change.js";
import { loaderSeams } from "./loader.js";
import type {
  ApprovedCapabilityContext,
  CapabilityModule,
} from "./runtime-contract.js";
import { compositionStore } from "./store.js";

const PASSKEYS = "vault.passkey-records";
const MODULE = `${PASSKEYS}/runtime`;

type Gate = { open: () => void; wait: Promise<void> };

function gate(): Gate {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

function heldModule(held: () => Gate | null): CapabilityModule {
  return {
    capabilityRuntime: {
      capability: PASSKEYS,
      async activate(ctx: ApprovedCapabilityContext): Promise<RuntimeHandle> {
        await held()?.wait;
        ctx.register("route", {
          id: "passkeys.section",
          path: "/passkeys",
          element: () => null,
          framed: true,
          order: 10,
        });
        return { capability: PASSKEYS, dispose: () => {} };
      },
    },
  };
}

async function bootWithPasskeys(): Promise<void> {
  await bootPersonalLocal(compositionStore, "personal");
  const { draft, receipt } = draftFor(compositionStore, [PASSKEYS], "r1");
  const outcome = await compositionStore.commit(draft, receipt);
  if (outcome.status !== "committed") throw new Error(outcome.status);
}

beforeEach(freshRealm);

describe("activatedGeneration", () => {
  it("names a generation only after its activation pass finishes", async () => {
    await bootWithPasskeys();
    let pending: Gate | null = gate();
    loaderSeams.moduleTable = async () => ({
      [MODULE]: async () => heldModule(() => pending),
    });
    let notified = 0;
    const off = subscribeActivated(() => {
      notified += 1;
    });
    const stop = activatePlan(compositionStore);
    const first = compositionStore.getSnapshot().generation;
    await settle();
    expect(activatedGeneration()).not.toBe(first);

    pending?.open();
    await until(() => activatedGeneration() === first);
    expect(notified).toBe(1);

    // A new generation (the vault opening) is not reported while its own
    // pass is still running, whatever the previous one reported.
    pending = gate();
    compositionStore.invalidate("vault");
    const second = compositionStore.getSnapshot().generation;
    await settle();
    expect(activatedGeneration()).toBe(first);

    pending.open();
    await until(() => activatedGeneration() === second);
    stop();
    off();
  });

  it("reports a pass whose module was refused, so nothing waits on a failure", async () => {
    await bootWithPasskeys();
    loaderSeams.moduleTable = async () => ({
      [MODULE]: async () => {
        throw new Error("chunk failed to load");
      },
    });
    const stop = activatePlan(compositionStore);
    const generation = compositionStore.getSnapshot().generation;
    await until(() => activatedGeneration() === generation);
    stop();
  });
});
