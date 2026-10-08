/** @vitest-environment node */
// Real local age/AES engine and original SopsSession permits; not worker-host acceptance.
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
} from "@opensesame/os-domain";
import * as age from "age-encryption";
import { expect, it } from "vitest";
import { SopsError } from "./errors.js";
import {
  type EncryptionPlan,
  type ExecutionPermit,
  planDigest,
  planFromRecipients,
} from "./plan.js";
import { parseRequest, parseResponse } from "./protocol.js";
import type { OpenOutcome } from "./runner.js";
import { SopsSession } from "./session.js";

type Fixture = {
  live: SopsSession;
  identity: string;
  plan: EncryptionPlan;
  permit: ExecutionPermit;
};

function wire(value: object): JsonObject {
  const parsed: BoundaryValue = JSON.parse(JSON.stringify(value));
  if (!isJsonObject(parsed))
    throw new Error("expected an object on the worker wire");
  return parsed;
}

async function fixture(live: SopsSession): Promise<Fixture> {
  const identity = await age.generateX25519Identity();
  const recipient = await age.identityToRecipient(identity);
  const plan = planFromRecipients({ format: "json", groups: [[recipient]] });
  const permit = live.permit({
    vaultScope: null,
    documentGeneration: 1,
    approvedPlanDigest: await planDigest(plan),
  });
  return { live, identity, plan, permit };
}

async function encryptAndInspect({
  live,
  plan,
  permit,
}: Fixture): Promise<string> {
  const encrypt = parseRequest(
    wire({
      id: "encrypt",
      kind: "encryptNew",
      text: '{"secret":"original"}',
      plan,
      permit,
    }),
  );
  if (encrypt.kind !== "encryptNew") throw new Error("wrong parsed operation");
  const output = await live.runner.encryptNew(
    encrypt.text,
    encrypt.plan,
    encrypt.permit,
  );
  expect(output).not.toContain("original");
  expect(
    parseResponse({ id: encrypt.id, ok: true, kind: "output", output }),
  ).toMatchObject({ kind: "output", output });
  const inspect = parseRequest({
    id: "inspect",
    kind: "inspect",
    text: output,
    format: "json",
  });
  if (inspect.kind !== "inspect") throw new Error("wrong parsed operation");
  const inspection = await live.runner.inspect(inspect.text, inspect.format);
  expect(
    parseResponse(
      wire({ id: inspect.id, ok: true, kind: "inspect", inspection }),
    ),
  ).toMatchObject({ kind: "inspect", inspection: { encrypted: true } });
  return output;
}

async function openAttested(
  value: Fixture,
  output: string,
  expected: string,
): Promise<OpenOutcome> {
  const open = parseRequest(
    wire({
      id: "open",
      kind: "open",
      text: output,
      format: "json",
      identities: [value.identity],
      permit: value.permit,
    }),
  );
  if (open.kind !== "open") throw new Error("wrong parsed operation");
  const opened = await value.live.runner.open(
    open.text,
    open.format,
    open.identities,
    open.permit,
  );
  const accepted = parseResponse(
    wire({ id: open.id, ok: true, kind: "open", ...opened }),
  );
  expect(accepted).toMatchObject({
    kind: "open",
    handle: opened.handle,
    plaintext: opened.plaintext,
  });
  expect(JSON.parse(opened.plaintext)).toEqual({ secret: expected });
  expect(opened.report.openedGroups).toBe(1);
  return opened;
}

async function editAndRotate(
  value: Fixture,
  opened: OpenOutcome,
): Promise<{ rotated: string; handle: string }> {
  const { live, permit, plan } = value;
  const edited = parseRequest(
    wire({
      id: "save",
      kind: "saveEdited",
      handle: opened.handle,
      edited: '{"secret":"edited"}',
      permit,
    }),
  );
  if (edited.kind !== "saveEdited") throw new Error("wrong parsed operation");
  const saved = await live.runner.saveEdited(
    edited.handle,
    edited.edited,
    edited.permit,
  );
  const reopened = await openAttested(value, saved, "edited");
  const rotate = parseRequest(
    wire({
      id: "rotate",
      kind: "rotate",
      handle: reopened.handle,
      edited: null,
      plan,
      permit,
    }),
  );
  if (rotate.kind !== "rotate") throw new Error("wrong parsed operation");
  const rotated = await live.runner.rotate(
    rotate.handle,
    rotate.edited,
    rotate.plan,
    rotate.permit,
  );
  expect(rotated).not.toBe(saved);
  await openAttested(value, rotated, "edited");
  return { rotated, handle: reopened.handle };
}

async function denyDisposedAndStale(
  value: Fixture,
  output: { rotated: string; handle: string },
): Promise<void> {
  const { live, permit, plan } = value;
  const dispose = parseRequest({
    id: "dispose",
    kind: "dispose",
    handle: output.handle,
  });
  if (dispose.kind !== "dispose") throw new Error("wrong parsed operation");
  live.runner.dispose(dispose.handle);
  await expect(
    live.runner.saveEdited(output.handle, '{"secret":"denied"}', permit),
  ).rejects.toBeInstanceOf(SopsError);
  expect(parseResponse({ id: dispose.id, ok: true, kind: "done" })).toEqual({
    id: "dispose",
    ok: true,
    kind: "done",
  });
  const generation = live.bump();
  expect(
    parseRequest({ id: "invalidate", kind: "invalidate", generation }),
  ).toEqual({ id: "invalidate", kind: "invalidate", generation });
  await expect(
    live.runner.open(output.rotated, "json", [value.identity], permit),
  ).rejects.toBeInstanceOf(SopsError);
  // Old denied work does not prevent the new legitimate session from opening the authentic bytes.
  const fresh = live.permit({
    vaultScope: null,
    documentGeneration: 2,
    approvedPlanDigest: await planDigest(plan),
  });
  await openAttested({ ...value, permit: fresh }, output.rotated, "edited");
}

it("round-trips actual encrypt/open/edit/rotate/inspect outcomes through both protocol boundaries", async () => {
  const live = new SopsSession();
  try {
    const value = await fixture(live);
    const sealed = await encryptAndInspect(value);
    const opened = await openAttested(value, sealed, "original");
    const output = await editAndRotate(value, opened);
    await denyDisposedAndStale(value, output);
    // Editing/rekeying never changes the independently held original encrypted snapshot.
    const fresh = live.permit({ vaultScope: null, documentGeneration: 3 });
    await openAttested({ ...value, permit: fresh }, sealed, "original");
  } finally {
    live.bump();
  }
});

function malformedOperations(permit: JsonObject): JsonObject[] {
  return [
    {
      id: "open",
      kind: "open",
      text: "document",
      format: "json",
      identities: [1],
      permit,
    },
    { id: "save", kind: "saveEdited", handle: 1, edited: "document", permit },
    { id: "save", kind: "saveEdited", handle: "h", edited: 1, permit },
    {
      id: "encrypt",
      kind: "encryptNew",
      text: "document",
      plan: { format: "toml", groups: [], shamirThreshold: 1, policy: {} },
      permit,
    },
    {
      id: "rotate",
      kind: "rotate",
      handle: "h",
      edited: false,
      plan: { format: "json", groups: [], shamirThreshold: 1, policy: {} },
      permit,
    },
    { id: "dispose", kind: "dispose", handle: false },
    { id: "invalidate", kind: "invalidate", generation: "0" },
  ];
}

function malformedReplies(): JsonObject[] {
  return [
    { id: "reply", ok: true, kind: "inspect", inspection: null },
    {
      id: "reply",
      ok: true,
      kind: "open",
      handle: "h",
      plaintext: 1,
      inspection: {},
      report: {},
    },
    {
      id: "reply",
      ok: true,
      kind: "open",
      handle: "h",
      plaintext: "text",
      inspection: {},
      report: null,
    },
    { id: "reply", ok: true, kind: "output", output: false },
    { id: "reply", ok: false, code: 1, message: "failure" },
    { id: "reply", ok: false, code: "invalid_document", message: false },
    { id: "reply", ok: "true", kind: "done" },
  ];
}

it("rejects malformed operation/reply payloads without relying on fabricated permits", () => {
  const live = new SopsSession();
  try {
    const current = live.permit({ vaultScope: null, documentGeneration: 1 });
    const permit = wire(current);
    const original = JSON.stringify(permit);
    for (const message of malformedOperations(permit))
      expect(() => parseRequest(message)).toThrow(SopsError);
    for (const reply of malformedReplies())
      expect(() => parseResponse(reply)).toThrow(SopsError);
    expect(
      parseResponse({
        id: "failure",
        ok: false,
        code: "invalid_document",
        message: "safe failure",
      }),
    ).toMatchObject({ ok: false, code: "invalid_document" });
    expect(JSON.stringify(permit)).toBe(original);
    expect(live.isLive(current)).toBe(true);
  } finally {
    live.bump();
  }
});
