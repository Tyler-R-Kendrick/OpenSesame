import type {
  AuthenticationAlias,
  AuthenticationApplication,
  AuthenticationApplicationStore,
  AuthenticationChallenge,
  AuthenticationCredential,
  AuthenticationCredentialStore,
  AuthenticationOneTimeStore,
  AuthenticationRegistrationToken,
  AuthenticationServiceStores,
  AuthenticationSigninToken,
  AuthenticationUser,
  AuthenticationUserStore,
} from "@opensesame/os-domain";
import { and, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Database } from "./repos/postgres.js";
import * as schema from "./schema/index.js";

function cloneApplication(
  row: AuthenticationApplication,
): AuthenticationApplication {
  return {
    ...row,
    origins: [...row.origins],
    apiKeys: row.apiKeys.map((key) => ({ ...key })),
    configurations: row.configurations.map((configuration) => ({
      ...configuration,
      hints: [...configuration.hints],
    })),
  };
}

function cloneCredential(
  row: AuthenticationCredential,
): AuthenticationCredential {
  return {
    ...row,
    publicKey: new Uint8Array(row.publicKey),
    transports: [...row.transports],
  };
}

function cloneRegistration(
  row: AuthenticationRegistrationToken,
): AuthenticationRegistrationToken {
  return { ...row, aliases: [...row.aliases] };
}

function applicationState(value: string): AuthenticationApplication["state"] {
  if (value === "active" || value === "suspended" || value === "revoked")
    return value;
  throw new Error("invalid_authentication_application_state");
}

function userVerification(
  value: string,
): AuthenticationRegistrationToken["userVerification"] {
  if (
    value === "discouraged" ||
    value === "preferred" ||
    value === "required"
  ) {
    return value;
  }
  throw new Error("invalid_authentication_user_verification");
}

function challengePurpose(value: string): AuthenticationChallenge["purpose"] {
  if (value === "authentication" || value === "registration") return value;
  throw new Error("invalid_authentication_challenge_purpose");
}

function signinType(value: string): AuthenticationSigninToken["type"] {
  if (value === "magic_link" || value === "manual" || value === "passkey") {
    return value;
  }
  throw new Error("invalid_authentication_signin_type");
}

export function createMemoryAuthenticationServiceStores(): AuthenticationServiceStores {
  const applications = new Map<string, AuthenticationApplication>();
  const users = new Map<string, AuthenticationUser>();
  const aliases = new Map<string, AuthenticationAlias>();
  const credentials = new Map<string, AuthenticationCredential>();
  const registrations = new Map<string, AuthenticationRegistrationToken>();
  const challenges = new Map<string, AuthenticationChallenge>();
  const signin = new Map<string, AuthenticationSigninToken>();
  const key = (applicationId: string, id: string) => `${applicationId}\0${id}`;

  const stores: AuthenticationServiceStores = {
    applications: {
      async create(application) {
        if (applications.has(application.id))
          throw new Error("authentication_application_conflict");
        const row = cloneApplication(application);
        applications.set(row.id, row);
        return cloneApplication(row);
      },
      async get(id) {
        const row = applications.get(id);
        return row ? cloneApplication(row) : undefined;
      },
      async listByOwner(principalId) {
        return [...applications.values()]
          .filter((row) => row.ownerPrincipalId === principalId)
          .map(cloneApplication);
      },
      async listByOrganization(organizationId) {
        return [...applications.values()]
          .filter((row) => row.organizationId === organizationId)
          .map(cloneApplication);
      },
      async update(application) {
        if (!applications.has(application.id))
          throw new Error("authentication_application_not_found");
        const row = cloneApplication(application);
        applications.set(row.id, row);
        return cloneApplication(row);
      },
    },
    users: {
      async put(user, nextAliases) {
        const normalized = [...new Set(nextAliases)];
        for (const alias of normalized) {
          const existing = aliases.get(key(user.applicationId, alias));
          if (existing && existing.userId !== user.userId) {
            throw new Error("authentication_alias_conflict");
          }
        }
        for (const [aliasKey, row] of aliases) {
          if (
            row.applicationId === user.applicationId &&
            row.userId === user.userId
          ) {
            aliases.delete(aliasKey);
          }
        }
        users.set(key(user.applicationId, user.userId), { ...user });
        for (const alias of normalized) {
          aliases.set(key(user.applicationId, alias), {
            applicationId: user.applicationId,
            alias,
            userId: user.userId,
          });
        }
        return { ...user };
      },
      async get(applicationId, userId) {
        const row = users.get(key(applicationId, userId));
        return row ? { ...row } : undefined;
      },
      async findByAlias(applicationId, alias) {
        const link = aliases.get(key(applicationId, alias));
        if (!link) return undefined;
        const row = users.get(key(applicationId, link.userId));
        return row ? { ...row } : undefined;
      },
      async aliases(applicationId, userId) {
        return [...aliases.values()]
          .filter(
            (row) =>
              row.applicationId === applicationId && row.userId === userId,
          )
          .map((row) => row.alias);
      },
      async list(applicationId) {
        return [...users.values()]
          .filter((row) => row.applicationId === applicationId)
          .map((row) => ({ ...row }));
      },
    },
    credentials: {
      async create(credential) {
        const id = key(credential.applicationId, credential.credentialId);
        if (credentials.has(id))
          throw new Error("authentication_credential_conflict");
        const row = cloneCredential(credential);
        credentials.set(id, row);
        return cloneCredential(row);
      },
      async get(applicationId, credentialId) {
        const row = credentials.get(key(applicationId, credentialId));
        return row ? cloneCredential(row) : undefined;
      },
      async listByUser(applicationId, userId) {
        return [...credentials.values()]
          .filter(
            (row) =>
              row.applicationId === applicationId && row.userId === userId,
          )
          .map(cloneCredential);
      },
      async rename(applicationId, credentialId, name, at) {
        const id = key(applicationId, credentialId);
        const row = credentials.get(id);
        if (!row) return false;
        const next: AuthenticationCredential = { ...row, updatedAt: at };
        if (name === undefined) Reflect.deleteProperty(next, "name");
        else next.name = name;
        credentials.set(id, next);
        return true;
      },
      async remove(applicationId, credentialId) {
        return credentials.delete(key(applicationId, credentialId));
      },
      async recordUse(
        applicationId,
        credentialId,
        expectedCounter,
        nextCounter,
        at,
      ) {
        const id = key(applicationId, credentialId);
        const row = credentials.get(id);
        if (!row || row.counter !== expectedCounter) return false;
        if (nextCounter !== 0 && nextCounter <= expectedCounter) return false;
        credentials.set(id, {
          ...row,
          counter: nextCounter === 0 ? expectedCounter : nextCounter,
          lastUsedAt: at,
          updatedAt: at,
        });
        return true;
      },
    },
    oneTime: {
      registration: {
        async create(token, now) {
          if (now) {
            for (const [tokenHash, row] of registrations) {
              if (row.expiresAt <= now || row.consumedAt)
                registrations.delete(tokenHash);
            }
          }
          if (registrations.has(token.tokenHash))
            throw new Error("authentication_token_conflict");
          registrations.set(token.tokenHash, cloneRegistration(token));
        },
        async get(tokenHash) {
          const row = registrations.get(tokenHash);
          return row ? cloneRegistration(row) : undefined;
        },
        async consume(tokenHash, now) {
          const row = registrations.get(tokenHash);
          if (!row || row.consumedAt || row.expiresAt <= now) return undefined;
          const consumed = { ...row, consumedAt: now };
          registrations.set(tokenHash, consumed);
          return cloneRegistration(consumed);
        },
      },
      challenges: {
        async create(challenge, now) {
          if (now) {
            for (const [value, row] of challenges) {
              if (row.expiresAt <= now) challenges.delete(value);
            }
          }
          if (challenges.has(challenge.challenge))
            throw new Error("authentication_challenge_conflict");
          challenges.set(challenge.challenge, { ...challenge });
        },
        async consume(challenge, now) {
          const row = challenges.get(challenge);
          challenges.delete(challenge);
          return row && row.expiresAt > now ? { ...row } : undefined;
        },
      },
      signin: {
        async create(token, now) {
          if (now) {
            for (const [tokenHash, row] of signin) {
              if (row.expiresAt <= now || row.consumedAt)
                signin.delete(tokenHash);
            }
          }
          if (signin.has(token.tokenHash))
            throw new Error("authentication_token_conflict");
          signin.set(token.tokenHash, { ...token });
        },
        async consume(tokenHash, now) {
          const row = signin.get(tokenHash);
          if (!row || row.consumedAt || row.expiresAt <= now) return undefined;
          const consumed = { ...row, consumedAt: now };
          signin.set(tokenHash, consumed);
          return { ...consumed };
        },
      },
    },
    async completeRegistration(input) {
      const token = registrations.get(input.tokenHash);
      if (!token || token.consumedAt || token.expiresAt <= input.now)
        return false;
      const credentialKey = key(
        input.credential.applicationId,
        input.credential.credentialId,
      );
      if (credentials.has(credentialKey)) return false;
      const normalized = [...new Set(input.aliases)];
      for (const alias of normalized) {
        const existing = aliases.get(key(input.user.applicationId, alias));
        if (existing && existing.userId !== input.user.userId) return false;
      }
      registrations.set(input.tokenHash, { ...token, consumedAt: input.now });
      for (const [aliasKey, row] of aliases) {
        if (
          row.applicationId === input.user.applicationId &&
          row.userId === input.user.userId
        ) {
          aliases.delete(aliasKey);
        }
      }
      users.set(key(input.user.applicationId, input.user.userId), {
        ...input.user,
      });
      for (const alias of normalized) {
        aliases.set(key(input.user.applicationId, alias), {
          applicationId: input.user.applicationId,
          alias,
          userId: input.user.userId,
        });
      }
      credentials.set(credentialKey, cloneCredential(input.credential));
      return true;
    },
  };
  return stores;
}

function mapApplication(
  row: typeof schema.authenticationApplications.$inferSelect,
): AuthenticationApplication {
  return {
    id: row.id,
    ownerPrincipalId: row.ownerPrincipalId,
    ...(row.organizationId
      ? { organizationId: row.organizationId }
      : undefined),
    displayName: row.displayName,
    rpId: row.rpId,
    origins: [...row.origins],
    secretHash: row.secretHash,
    secretPrefix: row.secretPrefix,
    apiKeys: row.apiKeys.map((key) => ({ ...key })),
    configurations: row.configurations.map((configuration) => ({
      ...configuration,
      hints: [...configuration.hints],
    })),
    manualTokensEnabled: row.manualTokensEnabled,
    magicLinksEnabled: row.magicLinksEnabled,
    state: applicationState(row.state),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapUser(
  row: typeof schema.authenticationUsers.$inferSelect,
): AuthenticationUser {
  return {
    applicationId: row.applicationId,
    userId: row.userId,
    userName: row.userName,
    displayName: row.displayName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapCredential(
  row: typeof schema.authenticationCredentials.$inferSelect,
): AuthenticationCredential {
  return {
    applicationId: row.applicationId,
    credentialId: row.credentialId,
    userId: row.userId,
    publicKey: new Uint8Array(row.publicKey),
    counter: row.counter,
    transports: [...row.transports],
    ...(row.name ? { name: row.name } : undefined),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : undefined),
  };
}

function mapRegistration(
  row: typeof schema.authenticationRegistrationTokens.$inferSelect,
): AuthenticationRegistrationToken {
  return {
    tokenHash: row.tokenHash,
    applicationId: row.applicationId,
    userId: row.userId,
    userName: row.userName,
    displayName: row.displayName,
    aliases: [...row.aliases],
    aliasHashing: row.aliasHashing,
    ...(row.authenticatorAttachment === "cross-platform" ||
    row.authenticatorAttachment === "platform"
      ? {
          authenticatorAttachment: row.authenticatorAttachment,
        }
      : undefined),
    userVerification: userVerification(row.userVerification),
    expiresAt: row.expiresAt,
    ...(row.consumedAt ? { consumedAt: row.consumedAt } : undefined),
  };
}

function mapChallenge(
  row: typeof schema.authenticationChallenges.$inferSelect,
): AuthenticationChallenge {
  return {
    challenge: row.challenge,
    applicationId: row.applicationId,
    purpose: challengePurpose(row.purpose),
    ...(row.authenticationPurpose
      ? { authenticationPurpose: row.authenticationPurpose }
      : undefined),
    requireUserVerification: row.requireUserVerification,
    origin: row.origin,
    ...(row.userId ? { userId: row.userId } : undefined),
    ...(row.registrationTokenHash
      ? { registrationTokenHash: row.registrationTokenHash }
      : undefined),
    expiresAt: row.expiresAt,
  };
}

function mapSignin(
  row: typeof schema.authenticationSigninTokens.$inferSelect,
): AuthenticationSigninToken {
  return {
    tokenHash: row.tokenHash,
    applicationId: row.applicationId,
    userId: row.userId,
    purpose: row.purpose,
    type: signinType(row.type),
    expiresAt: row.expiresAt,
    ...(row.consumedAt ? { consumedAt: row.consumedAt } : undefined),
  };
}

export function createPostgresAuthenticationServiceStores(
  db: Database,
): AuthenticationServiceStores {
  return {
    applications: {
      async create(application) {
        const [row] = await db
          .insert(schema.authenticationApplications)
          .values({
            ...application,
            organizationId: application.organizationId ?? null,
          })
          .returning();
        if (!row) throw new Error("authentication_application_insert_failed");
        return mapApplication(row);
      },
      async get(id) {
        const [row] = await db
          .select()
          .from(schema.authenticationApplications)
          .where(eq(schema.authenticationApplications.id, id))
          .limit(1);
        return row ? mapApplication(row) : undefined;
      },
      async listByOwner(principalId) {
        const rows = await db
          .select()
          .from(schema.authenticationApplications)
          .where(
            eq(schema.authenticationApplications.ownerPrincipalId, principalId),
          );
        return rows.map(mapApplication);
      },
      async listByOrganization(organizationId) {
        const rows = await db
          .select()
          .from(schema.authenticationApplications)
          .where(
            eq(
              schema.authenticationApplications.organizationId,
              organizationId,
            ),
          );
        return rows.map(mapApplication);
      },
      async update(application) {
        const [row] = await db
          .update(schema.authenticationApplications)
          .set({
            displayName: application.displayName,
            rpId: application.rpId,
            origins: application.origins,
            secretHash: application.secretHash,
            secretPrefix: application.secretPrefix,
            apiKeys: application.apiKeys,
            configurations: application.configurations,
            manualTokensEnabled: application.manualTokensEnabled,
            magicLinksEnabled: application.magicLinksEnabled,
            state: application.state,
            updatedAt: application.updatedAt,
          })
          .where(eq(schema.authenticationApplications.id, application.id))
          .returning();
        if (!row) throw new Error("authentication_application_not_found");
        return mapApplication(row);
      },
    },
    users: {
      async put(user, nextAliases) {
        return db.transaction(async (tx) => {
          const [row] = await tx
            .insert(schema.authenticationUsers)
            .values(user)
            .onConflictDoUpdate({
              target: [
                schema.authenticationUsers.applicationId,
                schema.authenticationUsers.userId,
              ],
              set: {
                userName: user.userName,
                displayName: user.displayName,
                updatedAt: user.updatedAt,
              },
            })
            .returning();
          if (!row) throw new Error("authentication_user_insert_failed");
          await tx
            .delete(schema.authenticationAliases)
            .where(
              and(
                eq(
                  schema.authenticationAliases.applicationId,
                  user.applicationId,
                ),
                eq(schema.authenticationAliases.userId, user.userId),
              ),
            );
          const unique = [...new Set(nextAliases)];
          if (unique.length > 0) {
            await tx.insert(schema.authenticationAliases).values(
              unique.map((alias) => ({
                applicationId: user.applicationId,
                alias,
                userId: user.userId,
              })),
            );
          }
          return mapUser(row);
        });
      },
      async get(applicationId, userId) {
        const [row] = await db
          .select()
          .from(schema.authenticationUsers)
          .where(
            and(
              eq(schema.authenticationUsers.applicationId, applicationId),
              eq(schema.authenticationUsers.userId, userId),
            ),
          )
          .limit(1);
        return row ? mapUser(row) : undefined;
      },
      async findByAlias(applicationId, alias) {
        const [row] = await db
          .select({ user: schema.authenticationUsers })
          .from(schema.authenticationAliases)
          .innerJoin(
            schema.authenticationUsers,
            and(
              eq(
                schema.authenticationUsers.applicationId,
                schema.authenticationAliases.applicationId,
              ),
              eq(
                schema.authenticationUsers.userId,
                schema.authenticationAliases.userId,
              ),
            ),
          )
          .where(
            and(
              eq(schema.authenticationAliases.applicationId, applicationId),
              eq(schema.authenticationAliases.alias, alias),
            ),
          )
          .limit(1);
        return row ? mapUser(row.user) : undefined;
      },
      async aliases(applicationId, userId) {
        const rows = await db
          .select({ alias: schema.authenticationAliases.alias })
          .from(schema.authenticationAliases)
          .where(
            and(
              eq(schema.authenticationAliases.applicationId, applicationId),
              eq(schema.authenticationAliases.userId, userId),
            ),
          );
        return rows.map((row) => row.alias);
      },
      async list(applicationId) {
        const rows = await db
          .select()
          .from(schema.authenticationUsers)
          .where(eq(schema.authenticationUsers.applicationId, applicationId));
        return rows.map(mapUser);
      },
    },
    credentials: {
      async create(credential) {
        const [row] = await db
          .insert(schema.authenticationCredentials)
          .values({
            ...credential,
            name: credential.name ?? null,
            lastUsedAt: credential.lastUsedAt ?? null,
          })
          .returning();
        if (!row) throw new Error("authentication_credential_insert_failed");
        return mapCredential(row);
      },
      async get(applicationId, credentialId) {
        const [row] = await db
          .select()
          .from(schema.authenticationCredentials)
          .where(
            and(
              eq(schema.authenticationCredentials.applicationId, applicationId),
              eq(schema.authenticationCredentials.credentialId, credentialId),
            ),
          )
          .limit(1);
        return row ? mapCredential(row) : undefined;
      },
      async listByUser(applicationId, userId) {
        const rows = await db
          .select()
          .from(schema.authenticationCredentials)
          .where(
            and(
              eq(schema.authenticationCredentials.applicationId, applicationId),
              eq(schema.authenticationCredentials.userId, userId),
            ),
          );
        return rows.map(mapCredential);
      },
      async rename(applicationId, credentialId, name, at) {
        const rows = await db
          .update(schema.authenticationCredentials)
          .set({ name: name ?? null, updatedAt: at })
          .where(
            and(
              eq(schema.authenticationCredentials.applicationId, applicationId),
              eq(schema.authenticationCredentials.credentialId, credentialId),
            ),
          )
          .returning({ id: schema.authenticationCredentials.credentialId });
        return rows.length === 1;
      },
      async remove(applicationId, credentialId) {
        const rows = await db
          .delete(schema.authenticationCredentials)
          .where(
            and(
              eq(schema.authenticationCredentials.applicationId, applicationId),
              eq(schema.authenticationCredentials.credentialId, credentialId),
            ),
          )
          .returning({ id: schema.authenticationCredentials.credentialId });
        return rows.length === 1;
      },
      async recordUse(
        applicationId,
        credentialId,
        expectedCounter,
        nextCounter,
        at,
      ) {
        if (nextCounter !== 0 && nextCounter <= expectedCounter) return false;
        const rows = await db
          .update(schema.authenticationCredentials)
          .set({
            counter: nextCounter === 0 ? expectedCounter : nextCounter,
            lastUsedAt: at,
            updatedAt: at,
          })
          .where(
            and(
              eq(schema.authenticationCredentials.applicationId, applicationId),
              eq(schema.authenticationCredentials.credentialId, credentialId),
              eq(schema.authenticationCredentials.counter, expectedCounter),
            ),
          )
          .returning({ id: schema.authenticationCredentials.credentialId });
        return rows.length === 1;
      },
    },
    oneTime: {
      registration: {
        async create(token, now) {
          if (now) {
            await db
              .delete(schema.authenticationRegistrationTokens)
              .where(
                or(
                  lte(schema.authenticationRegistrationTokens.expiresAt, now),
                  isNotNull(schema.authenticationRegistrationTokens.consumedAt),
                ),
              );
          }
          await db.insert(schema.authenticationRegistrationTokens).values({
            ...token,
            consumedAt: token.consumedAt ?? null,
          });
        },
        async get(tokenHash) {
          const [row] = await db
            .select()
            .from(schema.authenticationRegistrationTokens)
            .where(
              eq(schema.authenticationRegistrationTokens.tokenHash, tokenHash),
            )
            .limit(1);
          return row ? mapRegistration(row) : undefined;
        },
        async consume(tokenHash, now) {
          const [row] = await db
            .update(schema.authenticationRegistrationTokens)
            .set({ consumedAt: now })
            .where(
              and(
                eq(
                  schema.authenticationRegistrationTokens.tokenHash,
                  tokenHash,
                ),
                isNull(schema.authenticationRegistrationTokens.consumedAt),
                gt(schema.authenticationRegistrationTokens.expiresAt, now),
              ),
            )
            .returning();
          return row ? mapRegistration(row) : undefined;
        },
      },
      challenges: {
        async create(challenge, now) {
          if (now) {
            await db
              .delete(schema.authenticationChallenges)
              .where(lte(schema.authenticationChallenges.expiresAt, now));
          }
          await db.insert(schema.authenticationChallenges).values({
            ...challenge,
            userId: challenge.userId ?? null,
            registrationTokenHash: challenge.registrationTokenHash ?? null,
          });
        },
        async consume(challenge, now) {
          return db.transaction(async (tx) => {
            const [row] = await tx
              .delete(schema.authenticationChallenges)
              .where(eq(schema.authenticationChallenges.challenge, challenge))
              .returning();
            return row && row.expiresAt > now ? mapChallenge(row) : undefined;
          });
        },
      },
      signin: {
        async create(token, now) {
          if (now) {
            await db
              .delete(schema.authenticationSigninTokens)
              .where(
                or(
                  lte(schema.authenticationSigninTokens.expiresAt, now),
                  isNotNull(schema.authenticationSigninTokens.consumedAt),
                ),
              );
          }
          await db.insert(schema.authenticationSigninTokens).values({
            ...token,
            consumedAt: token.consumedAt ?? null,
          });
        },
        async consume(tokenHash, now) {
          const [row] = await db
            .update(schema.authenticationSigninTokens)
            .set({ consumedAt: now })
            .where(
              and(
                eq(schema.authenticationSigninTokens.tokenHash, tokenHash),
                isNull(schema.authenticationSigninTokens.consumedAt),
                gt(schema.authenticationSigninTokens.expiresAt, now),
              ),
            )
            .returning();
          return row ? mapSignin(row) : undefined;
        },
      },
    },
    async completeRegistration(input) {
      return db.transaction(async (tx) => {
        const [token] = await tx
          .update(schema.authenticationRegistrationTokens)
          .set({ consumedAt: input.now })
          .where(
            and(
              eq(
                schema.authenticationRegistrationTokens.tokenHash,
                input.tokenHash,
              ),
              isNull(schema.authenticationRegistrationTokens.consumedAt),
              gt(schema.authenticationRegistrationTokens.expiresAt, input.now),
            ),
          )
          .returning();
        if (!token) return false;
        await tx
          .insert(schema.authenticationUsers)
          .values(input.user)
          .onConflictDoUpdate({
            target: [
              schema.authenticationUsers.applicationId,
              schema.authenticationUsers.userId,
            ],
            set: {
              userName: input.user.userName,
              displayName: input.user.displayName,
              updatedAt: input.user.updatedAt,
            },
          });
        await tx
          .delete(schema.authenticationAliases)
          .where(
            and(
              eq(
                schema.authenticationAliases.applicationId,
                input.user.applicationId,
              ),
              eq(schema.authenticationAliases.userId, input.user.userId),
            ),
          );
        const unique = [...new Set(input.aliases)];
        if (unique.length > 0) {
          await tx.insert(schema.authenticationAliases).values(
            unique.map((alias) => ({
              applicationId: input.user.applicationId,
              alias,
              userId: input.user.userId,
            })),
          );
        }
        await tx.insert(schema.authenticationCredentials).values({
          ...input.credential,
          name: input.credential.name ?? null,
          lastUsedAt: input.credential.lastUsedAt ?? null,
        });
        return true;
      });
    },
  };
}
