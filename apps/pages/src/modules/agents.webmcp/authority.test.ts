import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
/** @vitest-environment jsdom */
/**
 * The WebMCP execute wrapper takes operation authority before the handler
 * (ownership.md §4.2, LIFE-04). The tools are registered through
 * `registerWebMcpScope` and the real `@opensesame/webmcp` registrar onto a
 * `document.modelContext` stand-in, and called the way a browser agent calls
 * them — so what is proven is the wrapper an agent actually reaches,
 * including a tool the browser still holds after its capability went.
 */

import {
  bootPersonalLocal,
  draftFor,
  freshRealm,
} from "@opensesame/app-core/lib/capabilities/__tests__/harness.js";
import { deriveLease } from "@opensesame/app-core/lib/capabilities/lease.js";
import {
  bindLeaseToCapability,
  registerContribution,
} from "@opensesame/app-core/lib/capabilities/registry.js";
import {
  compositionStore,
  storeSeams,
} from "@opensesame/app-core/lib/capabilities/store.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import type {
  WebMcpToolDescriptor,
  WebMcpToolResult,
  WebMcpToolSpec,
} from "@opensesame/webmcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tagWebMcpTool } from "../ports-b.js";
import { registerWebMcpScope } from "./registrar.js";

const PASSKEYS = "vault.passkey-records";
const PASSKEY_OP = "pages.items.passkey.create";

type Handler = () => Promise<BoundaryValue>;

/** What the browser holds: every descriptor the page registered, by name. */
const browser = new Map<string, WebMcpToolDescriptor>();

function installModelContext(): void {
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: {
      registerTool(descriptor: WebMcpToolDescriptor) {
        browser.set(descriptor.name, descriptor);
      },
    },
  });
}

/** A tool tagged the way every module tags its own (`tagWebMcpTool`). */
function tagged(
  name: string,
  handler: Handler,
  owner: string,
  readOnly: boolean,
): WebMcpToolSpec {
  return tagWebMcpTool({
    name: `opensesame_${name}`,
    description: name,
    inputSchema: { type: "object", properties: {} },
    execute: handler,
    readOnly,
    capabilityIds: [owner],
    scope: "session",
  });
}

/** Approve PASSKEYS, register `tools` under its lease, offer them. */
async function offer(tools: readonly WebMcpToolSpec[]): Promise<void> {
  await bootPersonalLocal();
  const { draft, receipt } = draftFor(compositionStore, [PASSKEYS], "r1");
  await compositionStore.commit(draft, receipt);
  const child = deriveLease(compositionStore.currentLease());
  bindLeaseToCapability(child.lease, PASSKEYS);
  for (const tool of tools) {
    registerContribution("webmcp-tool", tool, child.lease);
  }
  await registerWebMcpScope("session", tools, new AbortController().signal);
}

/** Call a tool as a browser agent would; the SDK reports a throw as an error result. */
async function call(name: string): Promise<WebMcpToolResult> {
  const descriptor = browser.get(`opensesame_${name}`);
  if (!descriptor) throw new Error(`not offered: ${name}`);
  return descriptor.execute({});
}

function refusal(result: WebMcpToolResult): string {
  expect(result.isError).toBe(true);
  return result.content.map((part) => part.text).join("");
}

beforeEach(() => {
  freshRealm();
  browser.clear();
  installModelContext();
});

afterEach(() => {
  Reflect.deleteProperty(document, "modelContext");
});

describe("the WebMCP execute wrapper", () => {
  it("runs a read-only tool whose operation is approved", async () => {
    const handler = vi.fn<Handler>(async () => ({ ok: true }));
    await offer([tagged("lookup", handler, PASSKEY_OP, true)]);
    const result = await call("lookup");
    expect(result.isError).not.toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("admits a mutating tool across tabs, then runs it", async () => {
    const handler = vi.fn<Handler>(async () => ({ ok: true }));
    await offer([tagged("write", handler, PASSKEY_OP, false)]);
    const result = await call("write");
    expect(result.isError).not.toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("refuses a tool the browser still holds after its capability was disabled", async () => {
    const handler = vi.fn<Handler>(async () => ({ ok: true }));
    await offer([tagged("lookup", handler, PASSKEY_OP, true)]);
    await compositionStore.emergencyDisable(PASSKEYS);
    expect(refusal(await call("lookup"))).toMatch(/capability denied/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses every tool once the realm is locked", async () => {
    const handler = vi.fn<Handler>(async () => ({ ok: true }));
    await offer([tagged("lookup", handler, PASSKEY_OP, true)]);
    compositionStore.invalidate("vault-lock");
    expect(refusal(await call("lookup"))).toMatch(/capability denied/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails a mutating tool closed without Web Locks, and still answers a lookup", async () => {
    const write = vi.fn<Handler>(async () => ({ ok: true }));
    const lookup = vi.fn<Handler>(async () => ({ ok: true }));
    await offer([
      tagged("write", write, PASSKEY_OP, false),
      tagged("lookup", lookup, PASSKEY_OP, true),
    ]);
    storeSeams.locks = () => undefined;
    expect(refusal(await call("write"))).toMatch(/NO_SERIALIZATION/);
    expect(write).not.toHaveBeenCalled();
    expect((await call("lookup")).isError).not.toBe(true);
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("refuses a tool owned by an operation the plan does not approve", async () => {
    const handler = vi.fn<Handler>(async () => ({ ok: true }));
    await offer([tagged("other", handler, "not.approved", true)]);
    expect(refusal(await call("other"))).toMatch(/NOT_APPROVED/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses an untagged tool", async () => {
    const handler = vi.fn<Handler>(async () => ({ ok: true }));
    const bare: WebMcpToolSpec = {
      name: "opensesame_bare",
      description: "bare",
      inputSchema: { type: "object", properties: {} },
      execute: handler,
      readOnly: true,
    };
    await offer([bare]);
    expect(refusal(await call("bare"))).toMatch(/NOT_REGISTERED/);
    expect(handler).not.toHaveBeenCalled();
  });
  it("withholds a pending result from the original lease after withdrawal and regrant", async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    const tool = tagged(
      "pending_lookup",
      async () => {
        if (first) {
          first = false;
          entered();
          await held;
        }
        return { originalResult: true };
      },
      PASSKEY_OP,
      true,
    );
    await offer([tool]);
    const oldCall = call("pending_lookup");
    await started;
    await compositionStore.emergencyDisable(PASSKEYS);
    await offer([tool]);
    release();
    expect(refusal(await oldCall)).toMatch(
      /capability denied|registration_retired/,
    );
    expect((await call("pending_lookup")).isError).not.toBe(true);
  });
  it("pins the genuine owner before asynchronous authorization and never dispatches a successor handler", async () => {
    const owner = await persistentBrowserOwner();
    await vaultStore.unlock(owner.password);
    const handler = vi.fn<Handler>(async () => ({ ownerResult: true }));
    await offer([tagged("owner_gap", handler, PASSKEY_OP, true)]);
    const pending = call("owner_gap");
    vaultStore.lock();
    expect(refusal(await pending)).toMatch(/changed|authority|session/i);
    expect(handler).not.toHaveBeenCalled();
    await vaultStore.unlock(owner.password);
    expect((await call("owner_gap")).isError).not.toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    vaultStore.lock();
  });
});
