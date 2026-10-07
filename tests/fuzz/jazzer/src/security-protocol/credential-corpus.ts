/** Public bounded seeds for the three credential targets, never real vault material. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ControlledMcpRequest } from "@opensesame/app-core/lib/credential-canaries/mcp-protocol.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { metadata, provision } from "./independent-wire.js";

type Seed = { name: string; bytes: Buffer };
type Target = "canary" | "observation" | "crypto";
const input = (mode: number, value: string) =>
  Buffer.concat([Buffer.from([mode]), Buffer.from(value)]);
const json = (value: BoundaryValue) => JSON.stringify(value);

function mcpSeed(method: ControlledMcpRequest["method"]): Seed {
  const request: ControlledMcpRequest = { jsonrpc: "2.0", id: 1, method };
  if (method === "tools/call")
    request.params = { name: "canary.status", arguments: {} };
  return {
    name: `mcp-${method.replace("/", "-")}`,
    bytes: input(3, JSON.stringify(request)),
  };
}

function canarySeeds(): Seed[] {
  const id = Buffer.alloc(32, 7).toString("base64url");
  const binding = {
    v: 1,
    validatorId: "d48b5f13-a3f6-4170-8d7d-6b0c3d070d35",
    artifactId: "636aa007-8f09-45d0-b29b-8d8f708111d9",
    context: {
      vaultIdentity: "public-fuzz-vault",
      kind: "mcp_configuration",
      generation: 1,
    },
    digestB64: Buffer.alloc(32, 1).toString("base64"),
  };
  return [
    { name: "valid-id", bytes: input(0, id) },
    { name: "bad-padding-id", bytes: input(0, `${id}=`) },
    { name: "oversized-id", bytes: input(0, `${id}a`) },
    { name: "nul-id", bytes: input(0, `${id}\0`) },
    { name: "valid-reference", bytes: input(1, `oscanary:v1:${id}`) },
    { name: "ordinary-reference", bytes: input(1, "ordinary-reference") },
    { name: "valid-validator", bytes: input(2, json(binding)) },
    {
      name: "wrong-kind-validator",
      bytes: input(
        2,
        json({
          ...binding,
          context: { ...binding.context, kind: "connection_ref" },
        }),
      ),
    },
    ...(["initialize", "tools/list", "tools/call"] as const).map(mcpSeed),
    {
      name: "mcp-forbidden-call",
      bytes: input(
        3,
        json({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "vault.export", arguments: {} },
        }),
      ),
    },
    {
      name: "mcp-extra-argument",
      bytes: input(
        3,
        json({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "canary.status",
            arguments: { password: "forbidden-public-field" },
          },
        }),
      ),
    },
  ];
}

function observationSeeds(now: number): Seed[] {
  const p = provision(now);
  const m = metadata(now);
  return [
    { name: "valid-provision", bytes: input(0, json(p)) },
    ...[
      "http://controlled.example",
      "https://controlled.example/path",
      "https://user:password@controlled.example",
    ].map((origin, index) => ({
      name: `invalid-origin-${index}`,
      bytes: input(0, json({ ...p, origin })),
    })),
    {
      name: "short-key",
      bytes: input(0, json({ ...p, independentKeyMaterialB64: "AA==" })),
    },
    { name: "valid-metadata", bytes: input(1, json(m)) },
    {
      name: "forbidden-metadata",
      bytes: input(1, json({ ...m, password: "forbidden-public-field" })),
    },
    {
      name: "unknown-event",
      bytes: input(1, json({ ...m, event: { type: "vault_export" } })),
    },
    { name: "malformed-package", bytes: input(2, "{}") },
    { name: "malformed-ack", bytes: input(3, "{}") },
  ];
}

function cryptoSeeds(now: number): Seed[] {
  const m = metadata(now);
  return [
    { name: "valid-independent-packet-ack", bytes: Buffer.from([6]) },
    { name: "authenticated-closed-metadata", bytes: input(1, json(m)) },
    {
      name: "authenticated-forbidden-field",
      bytes: input(1, json({ ...m, password: "forbidden-public-field" })),
    },
    {
      name: "authenticated-unknown-event",
      bytes: input(1, json({ ...m, event: { type: "vault_export" } })),
    },
    { name: "authenticated-malformed-json", bytes: input(1, "invalid") },
    {
      name: "authenticated-malformed-utf8",
      bytes: Buffer.from([1, 0xc3, 0x28]),
    },
    { name: "genuine-mac-bad-aead", bytes: Buffer.from([2, 3]) },
    { name: "genuine-mac-wrong-binding", bytes: Buffer.from([3]) },
    { name: "genuine-mac-wrong-ack-package", bytes: Buffer.from([5]) },
    { name: "malformed-raw-ack", bytes: input(4, "{}") },
    { name: "malformed-raw-packet", bytes: input(0, "{}") },
  ];
}

export async function writeCredentialCorpus(directory: string): Promise<void> {
  const now = Date.now();
  const groups = {
    canary: canarySeeds(),
    observation: observationSeeds(now),
    crypto: cryptoSeeds(now),
  } satisfies Record<Target, Seed[]>;
  for (const [target, seeds] of Object.entries(groups)) {
    const path = resolve(directory, target);
    await mkdir(path, { recursive: true, mode: 0o700 });
    for (const seed of seeds) {
      if (seed.bytes.length > 8194)
        throw new Error("Public seed exceeds fuzz input bound");
      await writeFile(resolve(path, seed.name), seed.bytes, {
        flag: "wx",
        mode: 0o600,
      });
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const destination = process.argv[2];
  if (!destination)
    throw new Error("A private public-seed output directory is required");
  await writeCredentialCorpus(destination);
}
