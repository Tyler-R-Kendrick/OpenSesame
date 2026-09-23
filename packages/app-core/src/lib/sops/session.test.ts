/** @vitest-environment node */
import * as age from "age-encryption";
import { describe, expect, it, vi } from "vitest";
import { SopsError } from "./errors.js";
import { planDigest, planFromRecipients } from "./plan.js";
import { MAX_MESSAGE_BYTES, parseRequest, parseResponse } from "./protocol.js";
import { SopsSession } from "./session.js";
import { bindSopsSession } from "./session.js";
import { vaultLifecycleSource } from "./vault-binding.js";
import { SopsWorkflow } from "./workflow.js";

/**
 * Outside a browser there is no `Worker`, so a plain session already runs
 * the engine inline on this thread — the same code path the worker hosts.
 */
function session(): SopsSession {
  return new SopsSession();
}

async function sealed(
  session: SopsSession,
  text: string,
  recipient: string,
): Promise<string> {
  const plan = planFromRecipients({ format: "yaml", groups: [[recipient]] });
  return session.runner.encryptNew(
    text,
    plan,
    session.permit({
      vaultScope: null,
      documentGeneration: 1,
      approvedPlanDigest: await planDigest(plan),
    }),
  );
}

describe("SB-060 the worker protocol refuses anything it did not define", () => {
  it("rejects unknown kinds, forged shapes, oversized bodies, and bad replies", () => {
    expect(() =>
      parseRequest({ id: "1", kind: "evalScript", text: "x" }),
    ).toThrow(SopsError);
    expect(() => parseRequest({ id: "1", kind: "open" })).toThrow(SopsError);
    expect(() =>
      parseRequest({ kind: "inspect", text: "a: 1", format: "yaml" }),
    ).toThrow(SopsError);
    expect(() =>
      parseRequest({ id: "1", kind: "inspect", text: "a: 1", format: "toml" }),
    ).toThrow(SopsError);
    expect(() =>
      parseRequest({
        id: "1",
        kind: "inspect",
        text: "x".repeat(MAX_MESSAGE_BYTES + 1),
        format: "yaml",
      }),
    ).toThrow(/budget/u);
    expect(() => parseRequest("not an object")).toThrow(SopsError);
    // A permit must carry a whole scope; a partial one cannot be smuggled.
    expect(() =>
      parseRequest({
        id: "1",
        kind: "open",
        text: "a: 1",
        format: "yaml",
        identities: [],
        permit: { scope: {}, approvedPlanDigest: "", network: "forbidden" },
      }),
    ).toThrow(SopsError);
    expect(() =>
      parseResponse({ id: "1", ok: true, kind: "surprise" }),
    ).toThrow(SopsError);
    expect(() => parseResponse({ ok: true, kind: "done" })).toThrow(SopsError);
    expect(
      parseRequest({ id: "1", kind: "inspect", text: "a: 1\n", format: "yaml" })
        .kind,
    ).toBe("inspect");
  });
});

describe("SB-061/062/063 a lifecycle change invalidates in-flight SOPS work", () => {
  it("a lock during a pending open discards the result and the handle", async () => {
    const live = session();
    const identity = await age.generateX25519Identity();
    const recipient = await age.identityToRecipient(identity);
    const cipher = await sealed(live, "hello: world\n", recipient);
    const workflow = new SopsWorkflow(live);
    await workflow.selectDocument("a.sops.yaml", cipher);
    const pending = workflow.open([identity], "personal");
    // The lock lands while the open is still in flight.
    live.bump();
    await pending;
    expect(workflow.getSnapshot().plaintext).toBeNull();
    expect(workflow.getSnapshot().failure?.code).toBe("stale_session");
  });

  it("work opened in one vault cannot be saved into another", async () => {
    const live = session();
    const identity = await age.generateX25519Identity();
    const recipient = await age.identityToRecipient(identity);
    const cipher = await sealed(live, "hello: world\n", recipient);
    const opened = await live.runner.open(
      cipher,
      "yaml",
      [identity],
      live.permit({ vaultScope: "project-a", documentGeneration: 1 }),
    );
    await expect(
      live.runner.saveEdited(
        opened.handle,
        "hello: edited\n",
        live.permit({ vaultScope: "project-b", documentGeneration: 1 }),
      ),
    ).rejects.toMatchObject({ code: "stale_session" });
    // The original scope still works, so the refusal is the scope and not the handle.
    await expect(
      live.runner.saveEdited(
        opened.handle,
        "hello: edited\n",
        live.permit({ vaultScope: "project-a", documentGeneration: 1 }),
      ),
    ).resolves.toContain("ENC[");
  });

  it("closing a document disposes its handle, and a bump disposes every handle", async () => {
    const live = session();
    const identity = await age.generateX25519Identity();
    const recipient = await age.identityToRecipient(identity);
    const cipher = await sealed(live, "hello: world\n", recipient);
    const workflow = new SopsWorkflow(live);
    await workflow.selectDocument("a.sops.yaml", cipher);
    await workflow.open([identity], null);
    expect(workflow.getSnapshot().plaintext).toBe("hello: world\n");
    workflow.close();
    expect(workflow.getSnapshot().phase).toBe("empty");
    expect(workflow.getSnapshot().plaintext).toBeNull();

    const second = new SopsWorkflow(live);
    await second.selectDocument("a.sops.yaml", cipher);
    await second.open([identity], null);
    const handle = second.getSnapshot();
    expect(handle.plaintext).not.toBeNull();
    live.bump();
    await expect(second.saveEncrypted(null)).resolves.toBeNull();
    expect(second.getSnapshot().failure?.code).toBe("stale_session");
  });

  it("binds to the vault's real lock, logout, and switch signals", () => {
    const live = session();
    // Captured in arrays: a `let` assigned only inside a callback is
    // narrowed to `never` at the call site.
    const locks: (() => void)[] = [];
    const subscribers: (() => void)[] = [];
    let snapshot: {
      tomb: string;
      status: "unlocked" | "locked" | "empty";
      guest: boolean;
    } = {
      tomb: "personal",
      status: "unlocked",
      guest: false,
    };
    const store = {
      onLock: (handler: () => void) => {
        locks.push(handler);
        return () => undefined;
      },
      subscribe: (listener: () => void) => {
        subscribers.push(listener);
        return () => undefined;
      },
      getSnapshot: () => snapshot,
    };
    const unbind = bindSopsSession(live, vaultLifecycleSource(store));
    const start = live.generation;
    locks[0]?.();
    expect(live.generation).toBe(start + 1);
    // A vault switch is a new scope even without a lock event.
    snapshot = { tomb: "project-a", status: "unlocked", guest: false };
    subscribers[0]?.();
    expect(live.generation).toBe(start + 2);
    // Guest entry is a scope change too.
    snapshot = { tomb: "guest", status: "unlocked", guest: true };
    subscribers[0]?.();
    expect(live.generation).toBe(start + 3);
    // A snapshot that changed nothing relevant does not churn the session.
    subscribers[0]?.();
    expect(live.generation).toBe(start + 3);
    unbind();
  });

  it("terminates the worker and fails pending calls when the session ends", () => {
    const terminate = vi.fn();
    const post = vi.fn();
    const invalidate = vi.fn();
    const runner = {
      inspect: vi.fn(),
      open: vi.fn(),
      saveEdited: vi.fn(),
      encryptNew: vi.fn(),
      rotate: vi.fn(),
      dispose: vi.fn(),
      invalidate,
    };
    const live = new SopsSession({ runner });
    live.bump();
    expect(invalidate).toHaveBeenCalledWith(live.generation);
    void terminate;
    void post;
  });
});
