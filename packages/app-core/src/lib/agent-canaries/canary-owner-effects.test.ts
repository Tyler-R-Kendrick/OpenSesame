/** Actual AES custody, paired P-256 proofs and loopback HTTP receiver; no mocked crypto or transport. */
import { createServer } from "node:http";
import { overlapCast } from "@opensesame/os-domain";
import type {
  LocalCanaryCommand,
  LocalCanaryResult,
} from "@opensesame/vault-core/local-vault-security.js";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { listenCanaryReceiver } from "../../node/agent-canary-http.js";
import { createControlledCanaryReceiver } from "../../node/agent-canary-receiver.js";
import type { RetiredOwnerAuthenticatedData } from "../vault/retired-owner-operation.js";
import { runCanaryOwnerEffects } from "./canary-owner-effects.js";
import { ControlledCanaryResultSchema } from "./controlled-receiver-contract.js";
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of close.splice(0).reverse()) await cleanup();
});
async function fixture(excessRetention = false) {
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const address = reservation.address();
  const { port } = z
    .object({ port: z.number().int().positive() })
    .parse(address);
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const receiver = {
    endpoint: `http://127.0.0.1:${port}`,
    bindPort: port,
    serviceId: "a".repeat(64),
    browserOrigin: "https://owner.example",
  };
  const values = new Map<string, string>();
  const data = overlapCast<unknown, RetiredOwnerAuthenticatedData>({
    snapshot: { tomb: "owner" },
    resources: { recordDrainFailure: undefined },
    key: await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
    rootCommitment: `root:${"b".repeat(64)}`,
    contextWire: "owner-context-v1",
    check: () => {},
    readers: {
      device: {
        read: async (key: string) => {
          if (
            !/^opensesame-private\/agent-canaries\/[a-f0-9]{64}\.v1$/u.test(key)
          )
            throw new Error("Device port key refused.");
          return values.get(key) ?? null;
        },
        publish: async (
          key: string,
          expected: string | null,
          value: string,
        ) => {
          expect(values.get(key) ?? null).toBe(expected);
          values.set(key, value);
        },
      },
    },
  });
  const run = (
    action: LocalCanaryCommand["action"],
    signal = new AbortController().signal,
  ) => runCanaryOwnerEffects(data, { receiver, action }, signal);
  const pairing = await run({ kind: "pairing" });
  if (pairing.kind !== "pairing") throw new Error("Pairing missing.");
  const state = {
    v: 1 as const,
    serviceId: receiver.serviceId,
    records: [],
    events: [],
    sequence: 0,
  };
  const controlled = await createControlledCanaryReceiver(pairing.pairing, {
    state,
    save: async () => {},
  });
  const server = await listenCanaryReceiver({
    pairing: controlled.pairing,
    challenge: (value: Parameters<typeof controlled.challenge>[0]) =>
      controlled.challenge(value),
    observe: (id: string, token: string, invoked: boolean) =>
      controlled.observe(id, token, invoked),
    execute: async (value: Parameters<typeof controlled.execute>[0]) => {
      const result = ControlledCanaryResultSchema.parse(
        await controlled.execute(value),
      );
      if (excessRetention && result.kind === "enrolled")
        return {
          ...result,
          record: {
            ...result.record,
            expiresAt: result.record.expiresAt + 86400000,
          },
        };
      return result;
    },
  });
  close.push(server.close);
  return { data, values, receiver, run };
}
function enrolled(result: LocalCanaryResult) {
  if (result.kind !== "enrolled") throw new Error("Enrollment missing.");
  return result.record;
}
test("paired owner enrolls, exports detection-only MCP artifact, observes and removes it", async () => {
  const f = await fixture();
  const record = enrolled(
    await f.run({
      kind: "enroll",
      label: "research-canary",
      artifactKind: "mcp-config",
      retentionDays: 3,
      ownerConsent: true,
    }),
  );
  const exported = await f.run({ kind: "export", id: record.id });
  expect(exported.kind).toBe("configuration");
  if (exported.kind !== "configuration")
    throw new Error("Configuration missing.");
  const wire = JSON.stringify(exported.configuration);
  const parsed = JSON.parse(wire).mcpServers["research-canary"];
  const observed = await fetch(parsed.url, {
    method: "POST",
    headers: { ...parsed.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
  });
  expect(observed.ok).toBe(true);
  const inspection = await f.run({ kind: "inspect" });
  expect(inspection.kind).toBe("inspection");
  if (inspection.kind === "inspection")
    expect(inspection.events[0]?.event).toBe("canary_tool_invoked");
  expect([...f.values.values()].join("")).not.toContain(
    parsed.headers.Authorization.slice(7),
  );
  expect(await f.run({ kind: "remove", id: record.id })).toEqual({
    kind: "removed",
    id: record.id,
  });
  await expect(f.run({ kind: "export", id: record.id })).rejects.toThrow();
});
test("copied receiver and root contexts cannot adopt signing custody", async () => {
  const f = await fixture();
  await expect(
    runCanaryOwnerEffects(
      { ...f.data, rootCommitment: `root:${"c".repeat(64)}` },
      { receiver: f.receiver, action: { kind: "inspect" } },
      new AbortController().signal,
    ),
  ).rejects.toThrow("owner context");
  await expect(
    runCanaryOwnerEffects(
      f.data,
      {
        receiver: { ...f.receiver, browserOrigin: "https://foreign.example" },
        action: { kind: "inspect" },
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("owner context");
});
test("cancelled operation cannot enroll or expose pairing", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(f.run({ kind: "pairing" }, controller.signal)).rejects.toThrow(
    "retired",
  );
});

test("signed command cannot accept receiver-enlarged retention", async () => {
  const f = await fixture(true);
  await expect(
    f.run({
      kind: "enroll",
      label: "bounded canary",
      artifactKind: "connection-reference",
      retentionDays: 1,
      ownerConsent: true,
    }),
  ).rejects.toThrow("retention");
});
