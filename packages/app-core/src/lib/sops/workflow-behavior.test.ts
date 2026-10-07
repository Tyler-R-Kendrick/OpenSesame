/** @vitest-environment node */
import { afterEach, expect, it, vi } from "vitest";
import { SopsError } from "./errors.js";
import { planDigest, planFromRecipients } from "./plan.js";
import { SopsSession } from "./session.js";
import { newIdentity } from "./test-support.js";
import { SopsWorkflow } from "./workflow.js";

const sessions: SopsSession[] = [];
const workflows: SopsWorkflow[] = [];
const releases: (() => void)[] = [];
const drains: Promise<unknown>[] = [];
function session() {
  const live = new SopsSession();
  sessions.push(live);
  return live;
}
function workflow(live: SopsSession) {
  const flow = new SopsWorkflow(live);
  workflows.push(flow);
  return flow;
}
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(drains.splice(0));
  for (const flow of workflows.splice(0)) flow.close();
  for (const live of sessions.splice(0)) live.bump();
  vi.restoreAllMocks();
});
async function encrypt(live: SopsSession, text: string, recipient: string) {
  const plan = planFromRecipients({ format: "json", groups: [[recipient]] });
  return live.runner.encryptNew(
    text,
    plan,
    live.permit({
      vaultScope: "personal",
      documentGeneration: 1,
      approvedPlanDigest: await planDigest(plan),
    }),
  );
}
async function decrypt(text: string, identity: string) {
  const live = session();
  const opened = await live.runner.open(
    text,
    "json",
    [identity],
    live.permit({
      vaultScope: "personal",
      documentGeneration: 1,
    }),
  );
  try {
    return JSON.parse(opened.plaintext);
  } finally {
    live.runner.dispose(opened.handle);
  }
}
function barrier() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { held, release };
}

it("edits and saves a real encrypted document without changing its original", async () => {
  const id = await newIdentity();
  const live = session();
  const source = await encrypt(live, '{"secret":"original"}', id.recipient);
  const flow = workflow(live);
  const notified = vi.fn();
  const off = flow.subscribe(notified);
  await flow.selectDocument("generated.sops.json", source);
  expect(flow.getSnapshot()).toMatchObject({
    phase: "inspected",
    plaintext: null,
    busy: false,
  });
  await flow.open([id.identity], "personal");
  expect(JSON.parse(flow.getSnapshot().plaintext ?? "null")).toEqual({
    secret: "original",
  });
  flow.setEdited('{"secret":"edited"}');
  expect(flow.getSnapshot().dirty).toBe(true);
  expect(flow.contentForEncryption()).toBe('{"secret":"edited"}');
  const saved = await flow.saveEncrypted("personal");
  expect(saved).not.toBeNull();
  expect(saved?.includes('"edited"')).toBe(false);
  expect(await decrypt(saved ?? "", id.identity)).toEqual({ secret: "edited" });
  expect(await decrypt(source, id.identity)).toEqual({ secret: "original" });
  expect(flow.getSnapshot()).toMatchObject({
    busy: false,
    dirty: false,
    failure: null,
  });
  expect(notified).toHaveBeenCalled();
  const count = notified.mock.calls.length;
  off();
  flow.close();
  expect(notified.mock.calls.length).toBe(count);
  expect(flow.getSnapshot()).toMatchObject({ phase: "empty", plaintext: null });
});

it("rotates an edited document to a new recipient and preserves old-copy readability", async () => {
  const original = await newIdentity();
  const next = await newIdentity();
  const live = session();
  const source = await encrypt(
    live,
    '{"secret":"original"}',
    original.recipient,
  );
  const flow = workflow(live);
  await flow.selectDocument("generated.json", source);
  await flow.open([original.identity], "personal");
  flow.setEdited('{"secret":"rotated"}');
  const plan = planFromRecipients({
    format: "json",
    groups: [[next.recipient]],
  });
  const rotated = await flow.rotate(plan, "personal");
  expect(rotated).not.toBeNull();
  expect(await decrypt(rotated ?? "", next.identity)).toEqual({
    secret: "rotated",
  });
  await expect(
    decrypt(rotated ?? "", original.identity),
  ).rejects.toBeInstanceOf(SopsError);
  expect(await decrypt(source, original.identity)).toEqual({
    secret: "original",
  });
  expect(flow.getSnapshot()).toMatchObject({
    busy: false,
    dirty: false,
    failure: null,
  });
});

it("encrypts newly selected content using the approved plan and redacts a refused save", async () => {
  const id = await newIdentity();
  const live = session();
  const flow = workflow(live);
  await flow.selectDocument("new.json", '{"secret":"new content"}');
  expect(flow.contentForEncryption()).toBe('{"secret":"new content"}');
  const plan = planFromRecipients({ format: "json", groups: [[id.recipient]] });
  const encrypted = await flow.encryptNew(
    flow.contentForEncryption(),
    plan,
    "personal",
  );
  expect(await decrypt(encrypted ?? "", id.identity)).toEqual({
    secret: "new content",
  });
  await flow.selectDocument("encrypted.json", encrypted ?? "");
  await flow.open([id.identity], "personal");
  flow.setEdited('{"secret":"unsaved generated secret"}');
  const source = flow.getSnapshot().plaintext;
  expect(await flow.saveEncrypted("other-owner")).toBeNull();
  expect(flow.getSnapshot()).toMatchObject({
    dirty: true,
    busy: false,
    plaintext: source,
  });
  expect(flow.getSnapshot().failure?.code).toBe("stale_session");
  expect(
    flow.getSnapshot().failure?.message.includes("unsaved generated secret"),
  ).toBe(false);
});

it("drops a late real inspection after a second document was selected", async () => {
  const id = await newIdentity();
  const live = session();
  const first = await encrypt(live, '{"secret":"first"}', id.recipient);
  const second = await encrypt(live, '{"secret":"second"}', id.recipient);
  const flow = workflow(live);
  const held = barrier();
  let reached = false;
  const inspect = live.runner.inspect.bind(live.runner);
  vi.spyOn(live.runner, "inspect").mockImplementation(async (...args) => {
    const result = await inspect(...args);
    if (args[0] === first) {
      reached = true;
      await held.held;
    }
    return result;
  });
  const pending = flow.selectDocument("first.json", first);
  drains.push(pending);
  try {
    await vi.waitFor(() => expect(reached).toBe(true), {
      timeout: 1000,
      interval: 10,
    });
    await flow.selectDocument("second.json", second);
  } finally {
    held.release();
  }
  await pending;
  expect(flow.getSnapshot()).toMatchObject({
    fileName: "second.json",
    busy: false,
    plaintext: null,
  });
  await flow.open([id.identity], "personal");
  expect(JSON.parse(flow.getSnapshot().plaintext ?? "null")).toEqual({
    secret: "second",
  });
});

it("disposes a late genuinely opened handle and leaves the new document usable", async () => {
  const id = await newIdentity();
  const live = session();
  const first = await encrypt(live, '{"secret":"first"}', id.recipient);
  const second = await encrypt(live, '{"secret":"second"}', id.recipient);
  const flow = workflow(live);
  await flow.selectDocument("first.json", first);
  const held = barrier();
  let retiredHandle: string | undefined;
  const open = live.runner.open.bind(live.runner);
  const disposed = vi.spyOn(live.runner, "dispose");
  vi.spyOn(live.runner, "open").mockImplementation(async (...args) => {
    const result = await open(...args);
    if (args[0] === first) {
      retiredHandle = result.handle;
      await held.held;
    }
    return result;
  });
  const pending = flow.open([id.identity], "personal");
  drains.push(pending);
  try {
    await vi.waitFor(() => expect(retiredHandle).toBeDefined(), {
      timeout: 1000,
      interval: 10,
    });
    await flow.selectDocument("second.json", second);
  } finally {
    held.release();
  }
  await pending;
  expect(disposed).toHaveBeenCalledWith(retiredHandle);
  expect(flow.getSnapshot()).toMatchObject({
    fileName: "second.json",
    plaintext: null,
  });
  await flow.open([id.identity], "personal");
  expect(JSON.parse(flow.getSnapshot().plaintext ?? "null")).toEqual({
    secret: "second",
  });
});
