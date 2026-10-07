import { decodePresentedId } from "@opensesame/app-core/lib/credential-canaries/identifier.js";
import {
  parseControlledMcpRequest,
  validateControlledMcpRequest,
} from "@opensesame/app-core/lib/credential-canaries/mcp-protocol.js";
import { parseObservationReceiverProvision } from "@opensesame/app-core/lib/credential-observation/protocol.js";
import {
  openObservation,
  verifyObservationAcknowledgement,
} from "@opensesame/app-core/lib/credential-observation/seal.js";
import { expect, it, vi } from "vitest";
import { fuzz as canary } from "./credential_canary_parsers.js";
import { fuzz as observation } from "./credential_observation_parsers.js";
import { main as fallbackMain } from "./run.js";
import { fuzz as nativeCrypto } from "./security-protocol/credential-observation-native.js";
import {
  metadata,
  packet,
  provision,
  signedAck,
  signedAckBody,
  signedPackage,
} from "./security-protocol/independent-wire.js";
import { invariant, parsed, parsedAsync } from "./security-protocol/oracles.js";
const input = (mode: number, raw: string) =>
  Buffer.concat([Buffer.from([mode]), Buffer.from(raw)]);

it("exercises valid identifier, validator and complete MCP controls", () => {
  const id = Buffer.alloc(32, 7).toString("base64url");
  canary(input(0, id));
  canary(input(1, `oscanary:v1:${id}`));
  expect(decodePresentedId(id)).toHaveLength(32);
  canary(
    input(
      2,
      JSON.stringify({
        v: 1,
        validatorId: "d48b5f13-a3f6-4170-8d7d-6b0c3d070d35",
        artifactId: "636aa007-8f09-45d0-b29b-8d8f708111d9",
        context: {
          vaultIdentity: "public-control",
          kind: "mcp_configuration",
          generation: 1,
        },
        digestB64: Buffer.alloc(32, 1).toString("base64"),
      }),
    ),
  );
  canary(
    input(3, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })),
  );
  canary(
    input(
      3,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "canary.status", arguments: {} },
      }),
    ),
  );
  const forbidden = parseControlledMcpRequest(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "vault.export", arguments: {} },
    }),
  );
  expect(() => validateControlledMcpRequest(forbidden)).toThrow();
  canary(input(3, JSON.stringify(forbidden)));
  expect(() => decodePresentedId(`${id.slice(0, -1)}B`)).toThrow();
});
it("accepts an explicit independent provision and rejects unapproved origins and closed-field leaks", () => {
  const p = provision();
  observation(input(0, JSON.stringify(p)));
  observation(input(1, JSON.stringify(metadata())));
  expect(parseObservationReceiverProvision(JSON.stringify(p))).toEqual(p);
  for (const origin of [
    "http://controlled.example",
    "https://user:password@controlled.example",
    "https://controlled.example/path",
  ]) {
    expect(() =>
      parseObservationReceiverProvision(JSON.stringify({ ...p, origin })),
    ).toThrow();
    observation(input(0, JSON.stringify({ ...p, origin })));
  }
});
it("opens independent actual AES/HMAC packets and awaits genuine acknowledgement authentication", async () => {
  const now = Date.now();
  const p = await packet(
    new TextEncoder().encode(JSON.stringify(metadata(now))),
    now,
  );
  await expect(
    openObservation(JSON.stringify(p), provision(now), now),
  ).resolves.toEqual(metadata(now));
  await expect(
    verifyObservationAcknowledgement(
      JSON.stringify(await signedAck(p, now)),
      p,
      provision(now),
    ),
  ).resolves.toBeUndefined();
  await expect(nativeCrypto(Buffer.from([6]))).resolves.toBeUndefined();
});
it("rejects independently authenticated malformed inner metadata and wrong AEAD purpose", async () => {
  const now = Date.now();
  for (const inner of [
    { ...metadata(now), password: "forbidden" },
    { ...metadata(now), event: { type: "vault_export" } },
  ]) {
    const p = await packet(
      new TextEncoder().encode(JSON.stringify(inner)),
      now,
    );
    await expect(
      openObservation(JSON.stringify(p), provision(now), now),
    ).rejects.toThrow();
    await expect(
      nativeCrypto(input(1, JSON.stringify(inner))),
    ).resolves.toBeUndefined();
  }
  const wrong = await packet(
    new TextEncoder().encode(JSON.stringify(metadata(now))),
    now,
    "wrong-aead-purpose",
  );
  await expect(
    openObservation(JSON.stringify(wrong), provision(now), now),
  ).rejects.toThrow();
  const p = await packet(
    new TextEncoder().encode(JSON.stringify(metadata(now))),
    now,
  );
  const short = await signedPackage({
    ...p,
    ciphertextB64: Buffer.alloc(27).toString("base64"),
  });
  await expect(
    openObservation(JSON.stringify(short), provision(now), now),
  ).rejects.toThrow();
  await expect(nativeCrypto(Buffer.from([2, 3]))).resolves.toBeUndefined();
  await expect(nativeCrypto(Buffer.from([3]))).resolves.toBeUndefined();
});
it("rejects genuine HMAC acknowledgements for wrong bindings, epochs, clocks and purposes", async () => {
  const now = Date.now();
  const p = await packet(
    new TextEncoder().encode(JSON.stringify(metadata(now))),
    now,
  );
  const ack = await signedAck(p, now);
  for (const change of [
    { bindingId: "wrong-binding" },
    { keyEpoch: 8 },
    { acceptedAt: new Date(now - 300001).toISOString() },
  ]) {
    const changed = await signedAckBody({ ...ack, ...change });
    await expect(
      verifyObservationAcknowledgement(
        JSON.stringify(changed),
        p,
        provision(now),
      ),
    ).rejects.toThrow();
  }
  const wrongPurpose = await signedAck(
    p,
    now,
    "opensesame/credential-observation/v1",
  );
  await expect(
    verifyObservationAcknowledgement(
      JSON.stringify(wrongPurpose),
      p,
      provision(now),
    ),
  ).rejects.toThrow();
  await expect(nativeCrypto(Buffer.from([5]))).resolves.toBeUndefined();
});
it("never catches a failing security oracle as expected hostile input", async () => {
  expect(() => parsed(() => invariant(false, "unit control"))).toThrow(
    "security-fuzz oracle",
  );
  await expect(
    parsedAsync(async () => invariant(false, "async unit control")),
  ).rejects.toThrow("security-fuzz oracle");
});

it("keeps the awaited native crypto target out of the actual DEGRADED fallback discovery", async () => {
  const argv = process.argv;
  const output: string[] = [];
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
  try {
    process.argv = [
      argv[0] ?? "node",
      argv[1] ?? "unit",
      "credential-observation-native",
    ];
    vi.stubEnv("FUZZ_SECONDS", "1");
    await fallbackMain();
    expect(output.join("")).toContain("DEGRADED");
    expect(output.join("")).not.toContain("--> ");
  } finally {
    process.argv = argv;
    vi.unstubAllEnvs();
    write.mockRestore();
  }
});
