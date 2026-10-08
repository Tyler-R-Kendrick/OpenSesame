import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import vectors from "../lib/credential-observation/protocol-vectors.json";
import {
  OBSERVATION_ROUTE,
  metadataSchema,
  provisionSchema,
} from "../lib/credential-observation/protocol.js";
import {
  sealObservation,
  verifyObservationAcknowledgement,
} from "../lib/credential-observation/seal.js";
import { publicVectorProvision } from "../lib/credential-observation/vector-test-support.js";
import {
  type ObservationReferenceServerHandle,
  startObservationReferenceServer,
} from "./credential-observation-server.js";
const servers: ObservationReferenceServerHandle[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
it("runs a controlled real receiver, persists private evidence and idempotent ACK across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "os-observation-reference-"));
  directories.push(directory);
  const provision = provisionSchema.parse({
    ...publicVectorProvision(),
    origin: "http://127.0.0.1:18791",
    allowLoopback: true,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  const provisionFile = join(directory, "pairing.json");
  const stateFile = join(directory, "receipts.json");
  await writeFile(provisionFile, JSON.stringify(provision), { mode: 0o600 });
  const start = async () => {
    const server = await startObservationReferenceServer({
      provisionFile,
      stateFile,
      port: 0,
    });
    servers.push(server);
    const address = z
      .object({ port: z.number() })
      .parse(server.server.address());
    return `http://127.0.0.1:${address.port}`;
  };
  const packet = await sealObservation(
    metadataSchema.parse({ ...vectors.metadata, at: new Date().toISOString() }),
    provision,
  );
  const origin = await start();
  const send = (origin: string) =>
    fetch(origin + OBSERVATION_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(packet),
      redirect: "error",
      credentials: "omit",
    });
  const first = await send(origin);
  expect(first.status).toBe(200);
  const ack = await first.text();
  await verifyObservationAcknowledgement(ack, packet, provision);
  expect((await stat(stateFile)).mode & 0o077).toBe(0);
  expect(await readFile(stateFile, "utf8")).not.toContain(
    provision.independentKeyMaterialB64,
  );
  const firstServer = servers.shift();
  if (!firstServer) throw new Error("Missing reference server.");
  await firstServer.close();
  const secondOrigin = await start();
  expect(await (await send(secondOrigin)).text()).toBe(ack);
  const state = z
    .object({ receipts: z.array(z.unknown()) })
    .parse(JSON.parse(await readFile(stateFile, "utf8")));
  expect(state.receipts).toHaveLength(1);
  expect(
    (
      await fetch(`${secondOrigin}/other-route`, {
        method: "POST",
        body: JSON.stringify(packet),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await fetch(secondOrigin + OBSERVATION_ROUTE, {
        method: "POST",
        headers: { authorization: "synthetic-fixture-only" },
        body: JSON.stringify(packet),
      })
    ).status,
  ).toBe(400);
});
it("rejects broadly readable independent key files before opening a receiver", async () => {
  const directory = await mkdtemp(join(tmpdir(), "os-observation-reference-"));
  directories.push(directory);
  const provisionFile = join(directory, "pairing.json");
  await writeFile(provisionFile, JSON.stringify(vectors.provision), {
    mode: 0o600,
  });
  await chmod(provisionFile, 0o644);
  await expect(
    startObservationReferenceServer({
      provisionFile,
      stateFile: join(directory, "receipts.json"),
      port: 0,
    }),
  ).rejects.toThrow("private receiver file");
});
