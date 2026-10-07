import { describe, expect, it } from "vitest";
import vectors from "./protocol-vectors.json";
import { metadataSchema, packageBody, provisionSchema } from "./protocol.js";
import {
  ObservationReferenceReceiver,
  type ObservationReferenceState,
} from "./reference.js";
import {
  acknowledgeObservation,
  importObservationKeys,
  sealObservation,
  verifyObservationAcknowledgement,
} from "./seal.js";
import { publicVectorProvision } from "./vector-test-support.js";
const provision = () =>
  provisionSchema.parse({
    ...publicVectorProvision(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
const metadata = () =>
  metadataSchema.parse({
    ...vectors.metadata,
    eventId: crypto.randomUUID(),
    at: new Date().toISOString(),
  });
describe("controlled reference receiver durable authenticated evidence", () => {
  it("returns the same ACK after genuine replay/restart without duplicate evidence", async () => {
    const p = provision();
    let state: ObservationReferenceState | null = null;
    let writes = 0;
    const storage = {
      async read() {
        return state === null ? null : structuredClone(state);
      },
      async write(s: ObservationReferenceState) {
        writes += 1;
        state = structuredClone(s);
      },
    };
    const packet = await sealObservation(metadata(), p);
    const first = await new ObservationReferenceReceiver(p, storage).receive(
      JSON.stringify(packet),
    );
    const second = await new ObservationReferenceReceiver(p, storage).receive(
      JSON.stringify(packet),
    );
    expect(second).toEqual(first);
    expect(writes).toBe(1);
    await verifyObservationAcknowledgement(JSON.stringify(second), packet, p);
    const different = await sealObservation(metadata(), p);
    // Even a holder of the independent receiver key cannot redefine a used package UUID.
    const changed = { ...different, packageId: packet.packageId };
    const keys = await importObservationKeys(p.independentKeyMaterialB64);
    changed.macB64 = Buffer.from(
      await crypto.subtle.sign(
        "HMAC",
        keys.mac,
        new TextEncoder().encode(
          `opensesame/credential-observation/v1\n${packageBody(changed)}`,
        ),
      ),
    ).toString("base64");
    await expect(
      new ObservationReferenceReceiver(p, storage).receive(
        JSON.stringify(changed),
      ),
    ).rejects.toThrow();
  });
  it("never acknowledges when durable receipt persistence fails", async () => {
    const p = provision();
    const packet = await sealObservation(metadata(), p);
    const receiver = new ObservationReferenceReceiver(p, {
      async read() {
        return null;
      },
      async write() {
        throw new Error("disk unavailable");
      },
    });
    await expect(receiver.receive(JSON.stringify(packet))).rejects.toThrow(
      "disk unavailable",
    );
  });
  it("serializes genuine concurrent events and enforces eight accepted events per hour", async () => {
    const p = provision();
    let state: ObservationReferenceState | null = null;
    const receiver = new ObservationReferenceReceiver(p, {
      async read() {
        return state === null ? null : structuredClone(state);
      },
      async write(s) {
        state = structuredClone(s);
      },
    });
    const packets = await Promise.all(
      Array.from({ length: 9 }, () => sealObservation(metadata(), p)),
    );
    const results = await Promise.allSettled(
      packets.map((packet) => receiver.receive(JSON.stringify(packet))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(8);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const replay = await receiver.receive(JSON.stringify(packets[0]));
    expect(replay).toEqual(
      await acknowledgeObservation(
        packets[0],
        p,
        Date.parse(replay.acceptedAt),
      ),
    );
  });
});
