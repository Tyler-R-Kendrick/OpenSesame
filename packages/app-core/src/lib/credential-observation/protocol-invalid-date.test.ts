import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import vectors from "./protocol-vectors.json";
import { isoSchema, metadataSchema, packageSchema } from "./protocol.js";
import { openObservation } from "./seal.js";
import { publicVectorProvision } from "./vector-test-support.js";

describe("untrusted observation timestamps", () => {
  it.each(["216:45.107Z", "2026-10-07T03:16:45-f07Z"])(
    "rejects the actual fuzz timestamp %s without throwing a range error",
    async (at) => {
      expect(isoSchema.safeParse(at).success).toBe(false);
      expect(
        metadataSchema.safeParse({ ...vectors.metadata, at }).success,
      ).toBe(false);
      for (const field of ["issuedAt", "expiresAt"] as const) {
        const packet = { ...vectors.packet, [field]: at };
        expect(packageSchema.safeParse(packet).success).toBe(false);
        await expect(
          openObservation(
            JSON.stringify(packet),
            publicVectorProvision(),
            Date.parse(vectors.packet.issuedAt),
          ),
        ).rejects.toBeInstanceOf(ZodError);
      }
    },
  );
  it("accepts canonical instants and rejects normalized or noncanonical dates", () => {
    expect(isoSchema.parse(vectors.metadata.at)).toBe(vectors.metadata.at);
    for (const at of [
      "2026-02-30T00:00:00.000Z",
      "2026-10-07T03:16:45Z",
      "2026-10-07T03:16:45.000+00:00",
    ])
      expect(isoSchema.safeParse(at).success).toBe(false);
  });
});
