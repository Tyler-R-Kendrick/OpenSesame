import { type RequestListener, type Server, createServer } from "node:http";
import { afterEach } from "vitest";
import { z } from "zod";
import { configureHost } from "../../host.js";
import { createMemoryStorage } from "../../memory-storage.js";
import { createTestHost } from "../../test-host.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { currentCredentialObservationIdentity } from "../credential-canaries/owner.js";
import { kvDelete } from "../kv.js";
import { flushRetiredCredentialTelemetry } from "../retired-credentials/telemetry-queue.js";
import {
  PASSWORD,
  createRetiredCredentialFixture,
} from "../retired-credentials/test-support.js";
import {
  installObservationPlan,
  observationHostProfile,
} from "./plan-test-support.js";
import { metadataSchema, provisionSchema } from "./protocol.js";
import { outboxKey, receiverKey } from "./storage.js";
import { publicVectorProvision } from "./vector-test-support.js";
let planRestore = () => {};
export const owner = { tomb: "personal", currentPassword: PASSWORD };
let restore = () => {};
const servers: Server[] = [];
afterEach(async () => {
  await flushRetiredCredentialTelemetry();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  planRestore();
  restore();
  kvDelete(receiverKey("personal"));
  kvDelete(outboxKey("personal"));
  configureHost(createTestHost());
});
export async function fixture() {
  const plan = installObservationPlan();
  planRestore = plan.restore;
  configureHost(createTestHost({ locks: webLocksDouble() }));
  const f = await createRetiredCredentialFixture();
  restore = f.restore;
  const host = createTestHost({ locks: f.locks, ...observationHostProfile });
  if (!host.storage) throw new Error("Missing test storage.");
  configureHost({
    ...host,
    storage: { local: host.storage.local, session: createMemoryStorage() },
  });
  kvDelete(receiverKey("personal"));
  kvDelete(outboxKey("personal"));
  return {
    ...f,
    plan,
    identity: currentCredentialObservationIdentity("personal"),
  };
}
export function provision(origin = "http://127.0.0.1:18791") {
  return provisionSchema.parse({
    ...publicVectorProvision(),
    origin,
    allowLoopback: true,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
}
export function metadata(identity: string, trapId = "controlled-fixture") {
  return metadataSchema.parse({
    v: 1,
    eventId: crypto.randomUUID(),
    vaultIdentity: identity,
    event: { type: "retired_credential_observed", trapId, response: "reject" },
    at: new Date().toISOString(),
  });
}
export async function listen(handler: RequestListener) {
  // The handler overload below is passed explicitly by each real HTTP fixture.
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = z
    .object({ port: z.number().int().min(1).max(65535) })
    .parse(server.address());
  return `http://127.0.0.1:${address.port}`;
}
