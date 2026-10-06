import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EventSealError, createEventSealer } from "../src/event-seal.js";
import { MemoryRepositories } from "../src/repos/memory.js";
import { withSealedSecrets } from "../src/repos/sealed-secrets.js";
import {
  openLegacySecretText,
  openSecretText,
  sealSecretText,
} from "../src/secret-seal.js";

const secret = "a durable deployment key for envelope tests";
const sealer = createEventSealer(secret);

describe("customer secret envelopes", () => {
  it("uses fresh data keys and binds customer, record and secret type", () => {
    const sealed = sealer.seal(
      "secret:one",
      { value: "sensitive" },
      "customer-a",
    );
    expect(sealed.$sealed).toMatch(/^osev2\./);
    expect(sealer.open("secret:one", sealed, "customer-a")).toEqual({
      value: "sensitive",
    });
    expect(
      sealer.seal("secret:one", { value: "sensitive" }, "customer-a"),
    ).not.toEqual(sealed);
    expect(() => sealer.open("secret:one", sealed, "customer-b")).toThrow(
      EventSealError,
    );
    expect(() => sealer.open("secret:two", sealed, "customer-a")).toThrow(
      EventSealError,
    );
  });

  it("opens legacy column-bound ciphertext for migration", () => {
    const key = Buffer.from(
      hkdfSync("sha256", secret, "", "opensesame:event-seal:v1", 32),
    );
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("audit_events.metadata"));
    const packed = Buffer.concat([
      iv,
      cipher.update(JSON.stringify({ old: true })),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    expect(
      sealer.openLegacyForMigration(
        "audit_events.metadata:record",
        { $sealed: `osev1.${packed.toString("base64url")}` },
        "customer-a",
      ),
    ).toEqual({ old: true });
  });

  it("opens text envelopes regardless of whitespace and refuses corrupt markers", () => {
    const sealed = sealSecretText(sealer, "secret:one", "a", "sensitive");
    expect(
      openSecretText(
        sealer,
        "secret:one",
        "a",
        JSON.stringify(JSON.parse(sealed), null, 2),
      ),
    ).toBe("sensitive");
    expect(() => openSecretText(sealer, "secret:one", "b", sealed)).toThrow(
      EventSealError,
    );
    expect(() =>
      openSecretText(sealer, "secret:one", "a", '{"$sealed":"unknown"}'),
    ).toThrow(EventSealError);
    expect(() => openSecretText(sealer, "secret:one", "a", "legacy")).toThrow(
      EventSealError,
    );
    expect(openLegacySecretText(sealer, "secret:one", "a", "legacy")).toBe(
      "legacy",
    );
  });

  it("seals webhook keys beneath repositories and rejects another customer's row", async () => {
    const raw = new MemoryRepositories();
    const repos = withSealedSecrets(raw, sealer);
    const endpoint = {
      id: "hook-one",
      principalId: "customer-a",
      url: "https://example.test/hook",
      secret: "whsec_sensitive",
      createdAt: new Date(),
    };
    expect(await repos.webhookEndpoints.create(endpoint)).toEqual(endpoint);
    const stored = await raw.webhookEndpoints.getById(endpoint.id);
    expect(stored?.secret).not.toContain(endpoint.secret);
    if (!stored) throw new Error("missing persisted webhook");
    await raw.webhookEndpoints.create({
      ...stored,
      id: "hook-two",
      principalId: "customer-b",
    });
    await expect(repos.webhookEndpoints.getById("hook-two")).rejects.toThrow(
      EventSealError,
    );
  });
  it("seals push capabilities and preserves endpoint-digest upsert identity", async () => {
    const raw = new MemoryRepositories();
    const repos = withSealedSecrets(raw, sealer);
    const row = {
      id: "push-one",
      principalId: "customer-a",
      endpoint: "https://push.example.test/capability",
      authSecret: "push-secret",
      p256dhKey: "public",
      endpointDigest: "digest",
      createdAt: new Date(),
    };
    expect(await repos.pushSubscriptions.create(row)).toEqual(row);
    const stored = await raw.pushSubscriptions.getById(row.id);
    expect(stored?.endpoint).not.toContain(row.endpoint);
    expect(stored?.authSecret).not.toContain(row.authSecret);
    const updated = await repos.pushSubscriptions.create({
      ...row,
      id: "new-id",
      authSecret: "replacement",
    });
    expect(updated.authSecret).toBe("replacement");
    expect(
      (await repos.pushSubscriptions.findByEndpointDigest("digest"))
        ?.authSecret,
    ).toBe("replacement");
  });
});
