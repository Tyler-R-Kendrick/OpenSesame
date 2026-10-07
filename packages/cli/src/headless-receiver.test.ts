import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { currentCredentialObservationIdentity } from "@opensesame/app-core/lib/credential-canaries/owner.js";
import { provisionSchema } from "@opensesame/app-core/lib/credential-observation/protocol.js";
import {
  ObservationReferenceReceiver,
  type ObservationReferenceState,
} from "@opensesame/app-core/lib/credential-observation/reference.js";
import { readObservationOutbox } from "@opensesame/app-core/lib/credential-observation/storage.js";
import { bytesToB64 } from "@opensesame/vault-core/bytes.js";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { runCli } from "./run.js";
import { releaseVaultKv, useVaultKv } from "./vault-kv.js";
import { openLocalVault } from "./vault-session.js";

type CapturedReceiverState = { value: ObservationReferenceState | null };
const PASSWORD = "headless owner verification password";
function profile(
  externalServices: "allow" | "deny",
  origins: string[],
  revision = 1,
) {
  return {
    capabilityComposition: {
      schemaVersion: 1,
      instancePolicy: {
        schemaVersion: 1,
        kind: "InstanceCapabilityPolicy",
        instanceId: "headless-owner-test",
        revision: `r${revision}`,
        presetProvenance: null,
        capabilities: {
          default: "deny",
          required: [],
          optional: [],
          prohibited: [],
        },
        network: { externalServices, allowedServiceOrigins: origins },
        updates: {
          unknownCapabilities: "deny",
          expandedExposure: "require-approval",
        },
      },
    },
  };
}
type ReceiverJourney = {
  origin: string;
  command(
    args: string[],
    password?: string,
  ): Promise<{ code: number; output: string; errors: string }>;
  writeProfile(value: string): Promise<void>;
  pending(): Promise<number>;
  socketCount(): number;
  requestCount(): number;
  receiptCount(): number;
};
/** Every journey starts with a new real vault and no receiver-test dedup history. */
async function withReceiver(work: (journey: ReceiverJourney) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "os-headless-receiver-"));
  const recorded: CapturedReceiverState = { value: null };
  let sockets = 0;
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk.toString();
      response.end(JSON.stringify(await receiver.receive(raw)));
    } catch {
      response.statusCode = 400;
      response.end("Rejected");
    }
  });
  server.on("connection", () => {
    sockets++;
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = z
    .object({ port: z.number().int().min(1).max(65535) })
    .parse(server.address());
  const origin = `http://127.0.0.1:${address.port}`;
  const provision = provisionSchema.parse({
    v: 1,
    receiverId: "cli-reference",
    bindingId: "cli-owner-pairing",
    origin,
    independentKeyMaterialB64: bytesToB64(
      crypto.getRandomValues(new Uint8Array(64)),
    ),
    keyEpoch: 1,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    allowLoopback: true,
  });
  const receiver = new ObservationReferenceReceiver(provision, {
    async read() {
      return recorded.value === null ? null : structuredClone(recorded.value);
    },
    async write(value) {
      recorded.value = structuredClone(value);
    },
  });
  const pairing = join(directory, "pairing.json");
  const config = join(directory, "os-runtime-config.json");
  let output = "";
  let errors = "";
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((value) => {
      output += String(value);
      return true;
    });
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((value) => {
      errors += String(value);
      return true;
    });
  try {
    const store = await openLocalVault(directory);
    await store.create(PASSWORD);
    await store.flushPendingWrites();
    const identity = currentCredentialObservationIdentity(store.activeTomb());
    await releaseVaultKv();
    await writeFile(pairing, JSON.stringify(provision), { mode: 0o600 });
    await writeFile(config, JSON.stringify(profile("allow", [origin])), {
      mode: 0o600,
    });
    async function command(args: string[], password = PASSWORD) {
      output = "";
      errors = "";
      const code = await runCli(["security", "receiver", ...args, "--json"], {
        stateDir: directory,
        readPassword: async () => password,
      });
      return { code, output, errors };
    }
    expect(
      (await command(["configure", pairing, "--confirm-destination"])).code,
    ).toBe(0);
    const journey: ReceiverJourney = {
      origin,
      command,
      writeProfile: (value) => writeFile(config, value, { mode: 0o600 }),
      async pending() {
        await useVaultKv(directory);
        try {
          return (await readObservationOutbox("personal", identity)).entries
            .length;
        } finally {
          await releaseVaultKv();
        }
      },
      socketCount: () => sockets,
      requestCount: () => requests,
      receiptCount: () => recorded.value?.receipts.length ?? 0,
    };
    expect(await journey.pending()).toBe(0);
    expect(sockets).toBe(0);
    expect(compositionStore.getSnapshot().status).toBe("ready");
    expect(compositionStore.getSnapshot().plan?.network.externalServices).toBe(
      "allow",
    );
    await work(journey);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    await releaseVaultKv();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
}
it(
  "fresh headless owner pairs, authenticates a real socket ACK and enables delivery",
  () =>
    withReceiver(async (f) => {
      const result = await f.command(["test"]);
      expect(result.code, result.errors).toBe(0);
      expect(
        z
          .object({ testDelivered: z.literal(true) })
          .parse(JSON.parse(result.output)),
      ).toBeTruthy();
      expect(f.requestCount()).toBe(1);
      expect(f.receiptCount()).toBe(1);
      expect((await f.command(["enable"])).code).toBe(0);
    }),
  120000,
);
it(
  "fresh global denial reaches the real packet egress guard before any socket",
  () =>
    withReceiver(async (f) => {
      await f.writeProfile(JSON.stringify(profile("deny", [], 2)));
      const result = await f.command(["test"]);
      expect(result.code, result.errors).toBe(1);
      expect(result.errors).toContain("denied by the current plan");
      expect(compositionStore.getSnapshot().status).toBe("ready");
      expect(compositionStore.getSnapshot().policy?.revision).toBe("r2");
      expect(
        compositionStore.getSnapshot().plan?.network.externalServices,
      ).toBe("deny");
      expect(await f.pending()).toBe(1);
      expect(f.socketCount()).toBe(0);
    }),
  120000,
);
it(
  "fresh origin restriction reaches the real packet egress guard before any socket",
  () =>
    withReceiver(async (f) => {
      await f.writeProfile(
        JSON.stringify(profile("allow", ["https://other.invalid"], 2)),
      );
      const result = await f.command(["test"]);
      expect(result.code, result.errors).toBe(1);
      expect(result.errors).toContain("denied by the current plan");
      expect(compositionStore.getSnapshot().status).toBe("ready");
      expect(compositionStore.getSnapshot().policy?.revision).toBe("r2");
      expect(compositionStore.getSnapshot().plan?.network).toEqual({
        externalServices: "allow",
        allowedServiceOrigins: ["https://other.invalid"],
      });
      expect(await f.pending()).toBe(1);
      expect(f.socketCount()).toBe(0);
    }),
  120000,
);
it(
  "wrong owner is refused under a fresh ALLOW profile before packet creation",
  () =>
    withReceiver(async (f) => {
      expect(
        compositionStore.getSnapshot().plan?.network.externalServices,
      ).toBe("allow");
      expect((await f.command(["test"], "wrong owner password")).code).toBe(1);
      expect(await f.pending()).toBe(0);
      expect(f.socketCount()).toBe(0);
    }),
  120000,
);
it(
  "fresh invalid present policy fails closed with no prior outbox history",
  () =>
    withReceiver(async (f) => {
      await f.writeProfile(
        JSON.stringify({
          capabilityComposition: { schemaVersion: 1, instancePolicy: {} },
        }),
      );
      const result = await f.command(["test"]);
      expect(result.code).toBe(1);
      expect(
        compositionStore.getSnapshot().plan?.network.externalServices,
      ).toBe("deny");
      expect(await f.pending()).toBe(1);
      expect(f.socketCount()).toBe(0);
    }),
  120000,
);
it(
  "fresh malformed profile is refused before packet creation or any socket",
  () =>
    withReceiver(async (f) => {
      await f.writeProfile("{");
      expect((await f.command(["test"])).code).toBe(1);
      expect(await f.pending()).toBe(0);
      expect(f.socketCount()).toBe(0);
    }),
  120000,
);
