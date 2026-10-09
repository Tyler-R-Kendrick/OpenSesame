import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { EventSealError, createEventSealer } from "../src/event-seal.js";
import { sealLegacySecrets } from "../src/repos/sealed-secrets-sweep.js";
import { withSealedSecrets } from "../src/repos/sealed-secrets.js";
import * as schema from "../src/schema/index.js";
import { makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

const root = "runtime downgrade fixture root";
const sealer = createEventSealer(root);
let ctx: PgTestContext;
beforeAll(async () => {
  ctx = await createPgTestContext();
});
afterAll(async () => {
  await ctx.client.close();
});
function legacy(value: string): string {
  const key = Buffer.from(
    hkdfSync("sha256", root, "", "opensesame:event-seal:v1", 32),
  );
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("webhook_endpoints.secret"));
  const packed = Buffer.concat([
    nonce,
    cipher.update(JSON.stringify({ value })),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return JSON.stringify({ $sealed: `osev1.${packed.toString("base64url")}` });
}
it.each(["plaintext", "osev1"])(
  "rejects %s customer replay at runtime but permits explicit migration",
  async (format) => {
    const owner = await ctx.repos.principals.create(makePrincipal());
    const repos = withSealedSecrets(ctx.repos, sealer);
    const id = `runtime-downgrade-${format}`;
    await repos.webhookEndpoints.create({
      id,
      principalId: owner.id,
      url: "https://fixture.example/hook",
      secret: "current-secret",
      createdAt: new Date(),
    });
    const replacement =
      format === "plaintext"
        ? "foreign-customer-secret"
        : legacy("foreign-customer-secret");
    await ctx.db
      .update(schema.webhookEndpoints)
      .set({ secret: replacement })
      .where(eq(schema.webhookEndpoints.id, id));
    await expect(repos.webhookEndpoints.getById(id)).rejects.toBeInstanceOf(
      EventSealError,
    );
    await expect(
      sealLegacySecrets(ctx.db, sealer, false),
    ).rejects.toBeInstanceOf(EventSealError);
    const [unchanged] = await ctx.db
      .select()
      .from(schema.webhookEndpoints)
      .where(eq(schema.webhookEndpoints.id, id));
    expect(unchanged?.secret).toBe(replacement);
    expect(await sealLegacySecrets(ctx.db, sealer, true)).toBe(1);
    expect((await repos.webhookEndpoints.getById(id))?.secret).toBe(
      "foreign-customer-secret",
    );
    const [row] = await ctx.db
      .select()
      .from(schema.webhookEndpoints)
      .where(eq(schema.webhookEndpoints.id, id));
    expect(row?.secret).toContain("osev2.");
    expect(await sealLegacySecrets(ctx.db, sealer, false)).toBe(0);
  },
);
