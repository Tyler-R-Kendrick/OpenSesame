import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  MemoryPrincipalMappingStore,
  createUpstreamAuth,
} from "@opensesame/auth-upstream";
import {
  createEventSealer,
  openSecretText,
  sealSecretText,
} from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";

type Session = { id: string; userId: string; token: string; expiresAt: Date };
interface InternalAdapter {
  createUser(input: {
    name: string;
    email: string;
    emailVerified: boolean;
  }): Promise<{ id: string }>;
  createSession(userId: string): Promise<Session>;
  findSession(token: string): Promise<{ session: Session } | null>;
  findSessions(tokens: string[]): Promise<{ session: Session }[]>;
  listSessions(userId: string): Promise<Session[]>;
  updateSession(
    token: string,
    update: { expiresAt: Date },
  ): Promise<Session | null>;
  deleteSession(token: string): Promise<void>;
  deleteSessions(tokens: string[]): Promise<void>;
}

it("persists sealed BetterAuth sessions while preserving real session lifecycle", async () => {
  const client = new PGlite();
  try {
    await client.waitReady;
    const db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../packages/database/drizzle",
      ),
    });
    const sealer = createEventSealer("session-test-key");
    const bundle = createUpstreamAuth({
      baseURL: "http://127.0.0.1:8788",
      basePath: "/auth",
      secret: "session-test-secret-with-enough-entropy",
      trustedOrigins: [],
      mappingStore: new MemoryPrincipalMappingStore(),
      magicLink: { sendMagicLink: async () => {} },
      database: {
        drizzle: db,
        schema: {
          user: schema.betterAuthUsers,
          session: schema.betterAuthSessions,
          account: schema.betterAuthAccounts,
          verification: schema.betterAuthVerifications,
        },
        accountSecrets: {
          lookup: (purpose, value) => sealer.lookupToken(purpose, value),
          seal: (purpose, owner, value) =>
            sealSecretText(sealer, purpose, owner, value),
          open: (purpose, owner, value) =>
            openSecretText(sealer, purpose, owner, value),
        },
      },
    });
    const context: { internalAdapter: InternalAdapter } = overlapCast(
      await bundle.auth.$context,
    );
    const adapter = context.internalAdapter;
    const user = await adapter.createUser({
      name: "Alice",
      email: "alice@example.test",
      emailVerified: true,
    });
    const session = await adapter.createSession(user.id);
    const [raw] = await db.select().from(schema.betterAuthSessions);
    expect(raw?.token).not.toBe(session.token);
    expect(raw?.token).toMatch(/^oslookup1\./);
    expect(raw?.sealedToken).not.toContain(session.token);
    expect(raw?.sealedToken).toContain("osev2.");
    expect((await adapter.findSession(session.token))?.session.token).toBe(
      session.token,
    );
    expect(await adapter.findSession(raw?.token ?? "")).toBeNull();
    expect((await adapter.listSessions(user.id))[0]?.token).toBe(session.token);
    expect(
      (await adapter.findSessions([session.token]))[0]?.session.token,
    ).toBe(session.token);
    const expiresAt = new Date(Date.now() + 120_000);
    expect(
      (await adapter.updateSession(session.token, { expiresAt }))?.token,
    ).toBe(session.token);
    await adapter.deleteSession(session.token);
    expect(await adapter.findSession(session.token)).toBeNull();
    const first = await adapter.createSession(user.id);
    const second = await adapter.createSession(user.id);
    await adapter.deleteSessions([first.token, second.token]);
    expect(await adapter.listSessions(user.id)).toEqual([]);
    const tampered = await adapter.createSession(user.id);
    const rival = await adapter.createUser({
      name: "Bob",
      email: "bob@example.test",
      emailVerified: true,
    });
    await db
      .update(schema.betterAuthSessions)
      .set({ userId: rival.id })
      .where(eq(schema.betterAuthSessions.id, tampered.id));
    await expect(adapter.findSession(tampered.token)).rejects.toThrow(
      "could not be opened",
    );
  } finally {
    await client.close();
  }
}, 60_000);
