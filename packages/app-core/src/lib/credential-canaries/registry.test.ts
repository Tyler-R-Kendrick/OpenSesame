import { afterEach, describe, expect, it } from "vitest";
import { kvDelete, kvGet, kvSet } from "../kv.js";
import { retiredCredentialStorageSeams } from "../retired-credentials/credential-lock.js";
import {
  PASSWORD,
  createRetiredCredentialFixture,
} from "../retired-credentials/test-support.js";
import { handleControlledMcpRequest } from "./mcp-validator.js";
import {
  observeControlledIdentifier,
  observeControlledReference,
} from "./observe.js";
import { currentCredentialObservationIdentity } from "./owner.js";
import vectors from "./protocol-vectors.json";
import {
  contextSchema,
  controlledCanaryReference,
  controlledIdentifierDigest,
  decodePresentedId,
  parseControlledCanaryReference,
} from "./protocol.js";
import {
  clearControlledCanaryEvents,
  configureCredentialCanaryIssuer,
  createControlledCanary,
  listControlledCanaries,
  removeControlledCanary,
  retireIssuedIdentifier,
} from "./registry.js";
import { canaryRegistryKey } from "./storage.js";
let restore = () => {};
afterEach(() => {
  restore();
  kvDelete(canaryRegistryKey("personal"));
});
async function fixture() {
  const f = await createRetiredCredentialFixture();
  restore = f.restore;
  kvDelete(canaryRegistryKey("personal"));
  return f;
}
const owner = { tomb: "personal", currentPassword: PASSWORD };
describe("controlled credential canaries", () => {
  it("matches published exact high-entropy protocol vectors", async () => {
    for (const vector of vectors.vectors)
      expect(
        await controlledIdentifierDigest(
          contextSchema.parse(vector.context),
          vector.presentedId,
        ),
      ).toBe(vector.digestB64);
    expect(() => decodePresentedId(`${"A".repeat(42)}B`)).toThrow();
    expect(() => parseControlledCanaryReference("oscanary:v1:bad")).toThrow();
    expect(parseControlledCanaryReference("production-ref")).toBeNull();
  });
  it("persists only digests, exact context matches and closed bounded evidence", async () => {
    await fixture();
    const artifact = await createControlledCanary({
      ...owner,
      kind: "connection_ref",
    });
    expect(kvGet(canaryRegistryKey("personal"))).not.toContain(
      artifact.presentedId,
    );
    expect(
      await observeControlledIdentifier({
        ...artifact,
        tomb: "personal",
        phase: "connected",
      }),
    ).toMatchObject({ kind: "canary", response: "synthetic_readonly" });
    expect(
      await observeControlledIdentifier({
        ...artifact,
        tomb: "personal",
        context: {
          ...artifact.context,
          generation: artifact.context.generation + 1,
        },
        phase: "invoked",
      }),
    ).toEqual({ kind: "unrecognized" });
    await observeControlledIdentifier({
      ...artifact,
      tomb: "personal",
      phase: "connected",
    });
    expect((await listControlledCanaries("personal")).events).toHaveLength(1);
    await clearControlledCanaryEvents(owner);
    expect((await listControlledCanaries("personal")).events).toHaveLength(0);
    await removeControlledCanary({ ...owner, artifactId: artifact.id });
    expect(
      await observeControlledIdentifier({
        ...artifact,
        tomb: "personal",
        phase: "connected",
      }),
    ).toEqual({ kind: "unrecognized" });
  });
  it("dispatch derives context and unknown reserved references never fall through", async () => {
    await fixture();
    const artifact = await createControlledCanary({
      ...owner,
      kind: "connection_ref",
    });
    expect(
      await observeControlledReference({
        tomb: "personal",
        reference: controlledCanaryReference(artifact.presentedId),
        phase: "invoked",
      }),
    ).toMatchObject({ kind: "canary" });
    await expect(
      observeControlledReference({
        tomb: "personal",
        reference: controlledCanaryReference("A".repeat(43)),
        phase: "invoked",
      }),
    ).rejects.toThrow();
    expect(
      await observeControlledReference({
        tomb: "personal",
        reference: "normal-production-ref",
        phase: "invoked",
      }),
    ).toEqual({ kind: "unrecognized" });
  });
  it("fresh real owner authentication guards writes and corrupted storage fails closed", async () => {
    const f = await fixture();
    await expect(
      createControlledCanary({
        ...owner,
        currentPassword: "wrong",
        kind: "agent_lease",
      }),
    ).rejects.toThrow();
    f.store.lock();
    await expect(
      createControlledCanary({ ...owner, kind: "agent_lease" }),
    ).rejects.toThrow();
    kvSet(canaryRegistryKey("personal"), "{}");
    await expect(listControlledCanaries("personal")).rejects.toThrow();
  });
  it("locking during a held registry refresh prevents a not-yet-dispatched owner write", async () => {
    const f = await fixture();
    const before = kvGet(canaryRegistryKey("personal"));
    let resume = () => {};
    let started = () => {};
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    retiredCredentialStorageSeams.refresh = async (key) => {
      if (key === canaryRegistryKey("personal")) {
        started();
        await held;
      }
    };
    const work = createControlledCanary({ ...owner, kind: "connection_ref" });
    const outcome = expect(work).rejects.toThrow();
    await ready;
    f.store.lock();
    resume();
    await outcome;
    expect(kvGet(canaryRegistryKey("personal"))).toBe(before);
  });
  it("locking while a genuine issuer resolution is outstanding prevents retirement writes", async () => {
    const f = await fixture();
    const identity = currentCredentialObservationIdentity("personal");
    const before = kvGet(canaryRegistryKey("personal"));
    let resume = () => {};
    let started = () => {};
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    configureCredentialCanaryIssuer({
      resolveRetiredIdentifier: async () => {
        started();
        await held;
        return {
          kind: "presented_identifier",
          presentedId: "A".repeat(43),
          context: {
            vaultIdentity: identity,
            kind: "agent_lease",
            generation: 1,
          },
        };
      },
    });
    const work = retireIssuedIdentifier({
      ...owner,
      issuerRecordRef: "verified-revoked-lease",
    });
    const outcome = expect(work).rejects.toThrow();
    await ready;
    f.store.lock();
    resume();
    await outcome;
    expect(kvGet(canaryRegistryKey("personal"))).toBe(before);
  });
  it("imports only trusted retired digest records bound to the fresh real owner", async () => {
    const f = await fixture();
    const vaultIdentity = currentCredentialObservationIdentity("personal");
    const context = {
      vaultIdentity,
      kind: "connection_ref" as const,
      generation: 7,
    };
    const presentedId = "A".repeat(43);
    const timestamp = new Date().toISOString();
    const artifact = {
      id: crypto.randomUUID(),
      context,
      digestB64: await controlledIdentifierDigest(context, presentedId),
      state: "retired" as const,
      createdAt: timestamp,
      retiredAt: timestamp,
    };
    configureCredentialCanaryIssuer({
      resolveRetiredIdentifier: async () => ({
        kind: "authenticated_retired_artifact",
        binding: { tomb: "other", vaultIdentity },
        artifact,
      }),
    });
    await expect(
      retireIssuedIdentifier({ ...owner, issuerRecordRef: artifact.id }),
    ).rejects.toThrow();
    expect((await listControlledCanaries(owner.tomb)).artifacts).toHaveLength(
      0,
    );
    configureCredentialCanaryIssuer({
      resolveRetiredIdentifier: async () => ({
        kind: "authenticated_retired_artifact",
        binding: { tomb: "personal", vaultIdentity },
        artifact,
      }),
    });
    await retireIssuedIdentifier({ ...owner, issuerRecordRef: artifact.id });
    expect((await listControlledCanaries(owner.tomb)).artifacts).toMatchObject([
      { id: artifact.id, context, state: "retired" },
    ]);
    expect(kvGet(canaryRegistryKey("personal"))).not.toContain(presentedId);
    f.store.lock();
    await expect(
      retireIssuedIdentifier({ ...owner, issuerRecordRef: artifact.id }),
    ).rejects.toThrow();
  });
  it("actual MCP dispatcher exposes only fixed synthetic calls without owner root", async () => {
    const f = await fixture();
    const artifact = await createControlledCanary({
      ...owner,
      kind: "mcp_configuration",
    });
    f.store.lock();
    const binding = { tomb: "personal", artifact };
    expect(
      await handleControlledMcpRequest(binding, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      }),
    ).toMatchObject({
      result: { serverInfo: { name: "OpenSesame controlled canary" } },
    });
    expect(
      await handleControlledMcpRequest(binding, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "canary.status", arguments: {} },
      }),
    ).toMatchObject({
      result: {
        content: [{ text: '{"environment":"synthetic","status":"available"}' }],
      },
    });
    await expect(
      handleControlledMcpRequest(binding, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "vault.export", arguments: {} },
      }),
    ).rejects.toThrow();
    expect(
      (await listControlledCanaries("personal")).events.map((e) => e.phase),
    ).toEqual(["connected", "invoked"]);
  });
});
