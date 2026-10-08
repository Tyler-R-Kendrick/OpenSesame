import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import vectors from "../lib/credential-observation/protocol-vectors.json";
import {
  MAX_PACKAGE_BYTES,
  OBSERVATION_ROUTE,
  PACKAGE_TTL_MS,
  metadataSchema,
  packageBody,
  provisionSchema,
} from "../lib/credential-observation/protocol.js";
import { referenceStateSchema } from "../lib/credential-observation/reference.js";
import {
  importObservationKeys,
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
  for (const server of servers.splice(0)) await server.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function receiver() {
  const directory = await mkdtemp(join(tmpdir(), "os-receiver-boundaries-"));
  directories.push(directory);
  const provision = provisionSchema.parse({
    ...publicVectorProvision(),
    origin: "http://127.0.0.1:18791",
    allowLoopback: true,
    expiresAt: new Date(Date.now() + 2 * PACKAGE_TTL_MS).toISOString(),
  });
  const provisionFile = join(directory, "pairing.json");
  const stateFile = join(directory, "receipts.json");
  await writeFile(provisionFile, JSON.stringify(provision), { mode: 0o600 });
  const handle = await startObservationReferenceServer({
    provisionFile,
    stateFile,
    port: 0,
  });
  servers.push(handle);
  const address = z.object({ port: z.number() }).parse(handle.server.address());
  const origin = `http://127.0.0.1:${address.port}`;
  const metadata = () =>
    metadataSchema.parse({
      ...vectors.metadata,
      eventId: crypto.randomUUID(),
      at: new Date().toISOString(),
    });
  const packet = await sealObservation(metadata(), provision);
  const send = (raw: string, headers: Record<string, string> = {}) =>
    fetch(origin + OBSERVATION_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: raw,
      credentials: "omit",
      redirect: "error",
    });
  return { handle, provision, stateFile, origin, metadata, packet, send };
}

it("serves only the fixed method/route without accepting ambient session credentials", async () => {
  const f = await receiver();
  const preflight = await fetch(f.origin + OBSERVATION_ROUTE, {
    method: "OPTIONS",
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-methods")).toBe(
    "POST, OPTIONS",
  );
  expect((await fetch(f.origin + OBSERVATION_ROUTE)).status).toBe(405);
  expect(
    (
      await fetch(`${f.origin}/v1/credential-observations/extra`, {
        method: "POST",
        body: JSON.stringify(f.packet),
      })
    ).status,
  ).toBe(404);
  const ambient: Record<string, string>[] = [
    { cookie: "session=public-test" },
    { authorization: "Bearer public-test" },
  ];
  for (const headers of ambient) {
    expect((await f.send(JSON.stringify(f.packet), headers)).status).toBe(400);
  }
  await expect(readFile(f.stateFile, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  const accepted = await f.send(JSON.stringify(f.packet));
  expect(accepted.status).toBe(200);
  await verifyObservationAcknowledgement(
    await accepted.text(),
    f.packet,
    f.provision,
  );
});

it.each([
  "malformed",
  "oversized",
  "foreign-binding",
  "expired",
  "damaged-mac",
] as const)(
  "refuses a %s observation without durable evidence, then accepts a genuine packet",
  async (variant) => {
    const f = await receiver();
    let raw = JSON.stringify(f.packet);
    if (variant === "malformed") raw = "{";
    if (variant === "oversized") raw = " ".repeat(MAX_PACKAGE_BYTES + 1);
    if (variant === "foreign-binding")
      raw = JSON.stringify(
        await sealObservation(f.metadata(), {
          ...f.provision,
          bindingId: "another-bound-owner",
        }),
      );
    if (variant === "expired")
      raw = JSON.stringify(
        await sealObservation(
          f.metadata(),
          f.provision,
          Date.now() - PACKAGE_TTL_MS - 1000,
        ),
      );
    if (variant === "damaged-mac") {
      const bytes = Buffer.from(f.packet.macB64, "base64");
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      raw = JSON.stringify({ ...f.packet, macB64: bytes.toString("base64") });
    }
    const refused = await f.send(raw);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "observation_rejected" });
    await expect(readFile(f.stateFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const accepted = await f.send(JSON.stringify(f.packet));
    expect(accepted.status).toBe(200);
    await verifyObservationAcknowledgement(
      await accepted.text(),
      f.packet,
      f.provision,
    );
    expect(
      referenceStateSchema.parse(
        JSON.parse(await readFile(f.stateFile, "utf8")),
      ).receipts,
    ).toHaveLength(1);
  },
);

it("an independently authenticated conflicting replay cannot replace accepted evidence or its ACK", async () => {
  const f = await receiver();
  const first = await f.send(JSON.stringify(f.packet));
  expect(first.status).toBe(200);
  const ack = await first.text();
  await verifyObservationAcknowledgement(ack, f.packet, f.provision);
  const stored = await readFile(f.stateFile, "utf8");
  const changed = {
    ...(await sealObservation(f.metadata(), f.provision)),
    packageId: f.packet.packageId,
  };
  const keys = await importObservationKeys(
    f.provision.independentKeyMaterialB64,
  );
  changed.macB64 = Buffer.from(
    await crypto.subtle.sign(
      "HMAC",
      keys.mac,
      new TextEncoder().encode(
        `opensesame/credential-observation/v1\n${packageBody(changed)}`,
      ),
    ),
  ).toString("base64");
  const refused = await f.send(JSON.stringify(changed));
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ error: "observation_rejected" });
  expect(await readFile(f.stateFile, "utf8")).toBe(stored);
  const replay = await f.send(JSON.stringify(f.packet));
  expect(replay.status).toBe(200);
  expect(await replay.text()).toBe(ack);
  expect(await readFile(f.stateFile, "utf8")).toBe(stored);
});

it("bounds incomplete concurrent requests and releases capacity after genuine authenticated completions", async () => {
  const f = await receiver();
  const raw = JSON.stringify(f.packet);
  let entered = 0;
  let ready = () => {};
  const admitted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const observed = () => {
    entered += 1;
    if (entered === 4) ready();
  };
  f.handle.server.on("request", observed);
  const held = Array.from({ length: 4 }, () => {
    let resolveResponse = (_value: { status: number; raw: string }) => {};
    let rejectResponse = (_error: Error) => {};
    const completed = new Promise<{ status: number; raw: string }>(
      (resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      },
    );
    const client = httpRequest(
      f.origin + OBSERVATION_ROUTE,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(raw),
        },
      },
      (response) => {
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.once("error", rejectResponse);
        response.once("end", () =>
          resolveResponse({
            status: response.statusCode ?? 0,
            raw: Buffer.concat(parts).toString("utf8"),
          }),
        );
      },
    );
    client.once("error", rejectResponse);
    // Actual HTTP requests reach the real listener and body iterator, which
    // withholds completion; the external request event only observes entry.
    client.write(raw.slice(0, 1));
    return { client, completed };
  });
  try {
    await admitted;
    const refused = await f.send(raw);
    expect(refused.status).toBe(429);
    for (const request of held) request.client.end(raw.slice(1));
    const responses = await Promise.all(
      held.map((request) => request.completed),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      await verifyObservationAcknowledgement(
        response.raw,
        f.packet,
        f.provision,
      );
    }
    expect(new Set(responses.map((response) => response.raw)).size).toBe(1);
    const later = await f.send(raw);
    expect(later.status).toBe(200);
    expect(await later.text()).toBe(responses[0]?.raw);
    expect(
      referenceStateSchema.parse(
        JSON.parse(await readFile(f.stateFile, "utf8")),
      ).receipts,
    ).toHaveLength(1);
  } finally {
    f.handle.server.off("request", observed);
    for (const request of held)
      request.client.destroy(new Error("Test request cancelled."));
    await Promise.allSettled(held.map((request) => request.completed));
  }
});
