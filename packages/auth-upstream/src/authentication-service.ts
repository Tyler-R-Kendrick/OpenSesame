import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  AuthenticationApplication,
  AuthenticationConfiguration,
  AuthenticationCredential,
  AuthenticationServiceStores,
  AuthenticationUser,
} from "@opensesame/os-domain";
import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  generatePasskeyAuthenticationOptions,
  generatePasskeyRegistrationOptions,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "./webauthn.js";

const CHALLENGE_TTL_MS = 5 * 60_000;
const REGISTRATION_TOKEN_TTL_MS = 5 * 60_000;

export const DEFAULT_AUTHENTICATION_CONFIGURATIONS: AuthenticationConfiguration[] =
  [
    {
      purpose: "sign-in",
      timeToLiveSeconds: 120,
      userVerification: "preferred",
      hints: [],
    },
    {
      purpose: "step-up",
      timeToLiveSeconds: 180,
      userVerification: "required",
      hints: [],
    },
  ];

export type AuthenticationSigninMode =
  | "autofill"
  | "discoverable"
  | "alias"
  | "user_id";

export class AuthenticationServiceError extends Error {
  constructor(
    readonly code:
      | "application_not_found"
      | "application_inactive"
      | "origin_not_allowed"
      | "invalid_token"
      | "invalid_response"
      | "unknown_credential"
      | "registration_conflict"
      | "configuration_not_found"
      | "feature_disabled",
  ) {
    super(code);
    this.name = "AuthenticationServiceError";
  }
}

export function hashAuthenticationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export interface MintedAuthenticationApplicationSecret {
  secret: string;
  secretHash: string;
  secretPrefix: string;
}

export function mintAuthenticationApplicationSecret(): MintedAuthenticationApplicationSecret {
  const secret = randomToken("osa_");
  return {
    secret,
    secretHash: hashAuthenticationToken(secret),
    secretPrefix: secret.slice(0, 12),
  };
}

export function authenticationApplicationSecretMatches(
  application: AuthenticationApplication,
  secret: string,
): boolean {
  const presented = Buffer.from(hashAuthenticationToken(secret), "hex");
  const hashes = application.apiKeys.length
    ? application.apiKeys
        .filter((key) => key.state === "active")
        .map((key) => key.secretHash)
    : [application.secretHash];
  return hashes.some((hash) => {
    const expected = Buffer.from(hash, "hex");
    return (
      expected.length === presented.length &&
      timingSafeEqual(expected, presented)
    );
  });
}

function normalizeAlias(alias: string): string {
  return alias.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function storedAlias(alias: string, hash: boolean): string {
  const normalized = normalizeAlias(alias);
  return hash
    ? `sha256:${createHash("sha256").update(normalized).digest("hex")}`
    : `plain:${normalized}`;
}

export function visibleAuthenticationAlias(alias: string): string | undefined {
  if (alias.startsWith("sha256:")) return undefined;
  return alias.startsWith("plain:") ? alias.slice(6) : alias;
}

function decodeClientChallenge(encoded: string): string | undefined {
  try {
    const parsed: BoundaryValue = overlapCast(
      JSON.parse(
        Buffer.from(
          encoded.replace(/-/g, "+").replace(/_/g, "/"),
          "base64",
        ).toString("utf8"),
      ),
    );
    return isJsonObject(parsed) && isString(parsed.challenge)
      ? parsed.challenge
      : undefined;
  } catch {
    return undefined;
  }
}

function userHandle(userId: string): string {
  return createHash("sha256").update(userId).digest("base64url");
}

export function createAuthenticationService(
  stores: AuthenticationServiceStores,
  clock: () => Date = () => new Date(),
) {
  async function activeApplication(
    id: string,
  ): Promise<AuthenticationApplication> {
    const application = await stores.applications.get(id);
    if (!application)
      throw new AuthenticationServiceError("application_not_found");
    if (application.state !== "active") {
      throw new AuthenticationServiceError("application_inactive");
    }
    return application;
  }

  function assertOrigin(
    application: AuthenticationApplication,
    origin: string,
  ): void {
    if (!application.origins.includes(origin)) {
      throw new AuthenticationServiceError("origin_not_allowed");
    }
  }

  function configuration(
    application: AuthenticationApplication,
    purpose: string,
  ): AuthenticationConfiguration {
    const found = application.configurations.find(
      (item) => item.purpose === purpose,
    );
    if (!found) throw new AuthenticationServiceError("configuration_not_found");
    return found;
  }

  return {
    async createRegistrationToken(input: {
      applicationId: string;
      userId: string;
      userName: string;
      displayName: string;
      aliases?: string[];
      aliasHashing?: boolean;
      authenticatorAttachment?: "cross-platform" | "platform";
      userVerification?: "discouraged" | "preferred" | "required";
    }) {
      await activeApplication(input.applicationId);
      const token = randomToken("ort_");
      const now = clock();
      await stores.oneTime.registration.create(
        {
          tokenHash: hashAuthenticationToken(token),
          applicationId: input.applicationId,
          userId: input.userId,
          userName: input.userName,
          displayName: input.displayName,
          aliases: [
            ...new Set(
              (input.aliases ?? [])
                .map((alias) => storedAlias(alias, input.aliasHashing ?? true))
                .filter(Boolean),
            ),
          ],
          aliasHashing: input.aliasHashing ?? true,
          ...(input.authenticatorAttachment
            ? { authenticatorAttachment: input.authenticatorAttachment }
            : undefined),
          userVerification: input.userVerification ?? "preferred",
          expiresAt: new Date(now.getTime() + REGISTRATION_TOKEN_TTL_MS),
        },
        now,
      );
      return {
        token,
        expiresAt: new Date(now.getTime() + REGISTRATION_TOKEN_TTL_MS),
      };
    },

    async registrationOptions(input: {
      applicationId: string;
      token: string;
      origin: string;
    }) {
      const application = await activeApplication(input.applicationId);
      assertOrigin(application, input.origin);
      const tokenHash = hashAuthenticationToken(input.token);
      const registration = await stores.oneTime.registration.get(tokenHash);
      const now = clock();
      if (
        !registration ||
        registration.applicationId !== application.id ||
        registration.consumedAt ||
        registration.expiresAt <= now
      ) {
        throw new AuthenticationServiceError("invalid_token");
      }
      const credentials = await stores.credentials.listByUser(
        application.id,
        registration.userId,
      );
      const options = await generatePasskeyRegistrationOptions({
        rp: { rpID: application.rpId, origin: input.origin },
        rpName: application.displayName,
        userId: userHandle(registration.userId),
        userName: registration.userName,
        userDisplayName: registration.displayName,
        excludeCredentialIds: credentials.map(
          (credential) => credential.credentialId,
        ),
        ...(registration.authenticatorAttachment
          ? { authenticatorAttachment: registration.authenticatorAttachment }
          : undefined),
        userVerification: registration.userVerification,
      });
      await stores.oneTime.challenges.create(
        {
          challenge: options.challenge,
          applicationId: application.id,
          purpose: "registration",
          origin: input.origin,
          userId: registration.userId,
          registrationTokenHash: tokenHash,
          requireUserVerification: registration.userVerification === "required",
          expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
        },
        now,
      );
      return options;
    },

    async verifyRegistration(input: {
      applicationId: string;
      response: RegistrationResponseJSON;
      name?: string;
    }) {
      const application = await activeApplication(input.applicationId);
      const challengeValue = decodeClientChallenge(
        input.response.response.clientDataJSON,
      );
      if (!challengeValue)
        throw new AuthenticationServiceError("invalid_response");
      const now = clock();
      const challenge = await stores.oneTime.challenges.consume(
        challengeValue,
        now,
      );
      if (
        !challenge ||
        challenge.applicationId !== application.id ||
        challenge.purpose !== "registration" ||
        !challenge.userId ||
        !challenge.registrationTokenHash
      ) {
        throw new AuthenticationServiceError("invalid_response");
      }
      const registration = await stores.oneTime.registration.get(
        challenge.registrationTokenHash,
      );
      if (
        !registration ||
        registration.applicationId !== application.id ||
        registration.userId !== challenge.userId ||
        registration.consumedAt ||
        registration.expiresAt <= now
      ) {
        throw new AuthenticationServiceError("invalid_token");
      }
      const verified = await verifyPasskeyRegistration({
        rp: { rpID: application.rpId, origin: challenge.origin },
        challenge: challenge.challenge,
        response: input.response,
        requireUserVerification: challenge.requireUserVerification,
      });
      if (!verified) throw new AuthenticationServiceError("invalid_response");
      const user: AuthenticationUser = {
        applicationId: application.id,
        userId: registration.userId,
        userName: registration.userName,
        displayName: registration.displayName,
        createdAt: now,
        updatedAt: now,
      };
      const credential: AuthenticationCredential = {
        applicationId: application.id,
        credentialId: verified.credentialId,
        userId: registration.userId,
        publicKey: verified.publicKey,
        counter: verified.counter,
        transports: input.response.response.transports ?? [],
        ...(input.name ? { name: input.name } : undefined),
        createdAt: now,
        updatedAt: now,
      };
      try {
        const completed = await stores.completeRegistration({
          tokenHash: challenge.registrationTokenHash,
          now,
          user,
          aliases: registration.aliases,
          credential,
        });
        if (!completed)
          throw new AuthenticationServiceError("registration_conflict");
      } catch (error) {
        if (error instanceof AuthenticationServiceError) throw error;
        throw new AuthenticationServiceError("registration_conflict");
      }
      return { userId: user.userId, credentialId: credential.credentialId };
    },

    async authenticationOptions(input: {
      applicationId: string;
      origin: string;
      mode: AuthenticationSigninMode;
      alias?: string;
      userId?: string;
      purpose?: string;
    }) {
      const application = await activeApplication(input.applicationId);
      assertOrigin(application, input.origin);
      const authConfiguration = configuration(
        application,
        input.purpose ?? "sign-in",
      );
      let user: AuthenticationUser | undefined;
      if (input.mode === "alias") {
        user = input.alias
          ? ((await stores.users.findByAlias(
              application.id,
              storedAlias(input.alias, true),
            )) ??
            (await stores.users.findByAlias(
              application.id,
              storedAlias(input.alias, false),
            )) ??
            (await stores.users.findByAlias(
              application.id,
              normalizeAlias(input.alias),
            )))
          : undefined;
      } else if (input.mode === "user_id") {
        user = input.userId
          ? await stores.users.get(application.id, input.userId)
          : undefined;
      }
      if ((input.mode === "alias" || input.mode === "user_id") && !user) {
        throw new AuthenticationServiceError("unknown_credential");
      }
      const credentials = user
        ? await stores.credentials.listByUser(application.id, user.userId)
        : [];
      if (user && credentials.length === 0) {
        throw new AuthenticationServiceError("unknown_credential");
      }
      const options = await generatePasskeyAuthenticationOptions({
        rp: { rpID: application.rpId, origin: input.origin },
        ...(user
          ? {
              allowCredentialIds: credentials.map(
                (credential) => credential.credentialId,
              ),
            }
          : undefined),
        userVerification: authConfiguration.userVerification,
        hints: authConfiguration.hints,
      });
      const now = clock();
      await stores.oneTime.challenges.create(
        {
          challenge: options.challenge,
          applicationId: application.id,
          purpose: "authentication",
          authenticationPurpose: authConfiguration.purpose,
          requireUserVerification:
            authConfiguration.userVerification === "required",
          origin: input.origin,
          ...(user ? { userId: user.userId } : undefined),
          expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
        },
        now,
      );
      return options;
    },

    async verifyAuthentication(input: {
      applicationId: string;
      response: AuthenticationResponseJSON;
    }) {
      const application = await activeApplication(input.applicationId);
      const challengeValue = decodeClientChallenge(
        input.response.response.clientDataJSON,
      );
      if (!challengeValue)
        throw new AuthenticationServiceError("invalid_response");
      const now = clock();
      const challenge = await stores.oneTime.challenges.consume(
        challengeValue,
        now,
      );
      if (
        !challenge ||
        challenge.applicationId !== application.id ||
        challenge.purpose !== "authentication"
      ) {
        throw new AuthenticationServiceError("invalid_response");
      }
      const credential = await stores.credentials.get(
        application.id,
        input.response.id,
      );
      if (
        !credential ||
        (challenge.userId && credential.userId !== challenge.userId)
      ) {
        throw new AuthenticationServiceError("unknown_credential");
      }
      const newCounter = await verifyPasskeyAuthentication({
        rp: { rpID: application.rpId, origin: challenge.origin },
        challenge: challenge.challenge,
        response: input.response,
        credential: {
          credentialId: credential.credentialId,
          publicKey: credential.publicKey,
          counter: credential.counter,
        },
        requireUserVerification: challenge.requireUserVerification,
      });
      if (newCounter === null)
        throw new AuthenticationServiceError("invalid_response");
      const persistedCounter = newCounter ?? credential.counter;
      if (
        !(await stores.credentials.recordUse(
          application.id,
          credential.credentialId,
          credential.counter,
          persistedCounter,
          now,
        ))
      ) {
        throw new AuthenticationServiceError("invalid_response");
      }
      const token = randomToken("ost_");
      const expiresAt = new Date(
        now.getTime() +
          configuration(
            application,
            challenge.authenticationPurpose ?? "sign-in",
          ).timeToLiveSeconds *
            1_000,
      );
      await stores.oneTime.signin.create(
        {
          tokenHash: hashAuthenticationToken(token),
          applicationId: application.id,
          userId: credential.userId,
          purpose: challenge.authenticationPurpose ?? "sign-in",
          type: "passkey",
          expiresAt,
        },
        now,
      );
      return { token, expiresAt };
    },

    async generateToken(input: {
      applicationId: string;
      userId: string;
      purpose?: string;
      timeToLiveSeconds?: number;
      type?: "magic_link" | "manual";
    }) {
      const application = await activeApplication(input.applicationId);
      const tokenType = input.type ?? "manual";
      if (
        (tokenType === "manual" && !application.manualTokensEnabled) ||
        (tokenType === "magic_link" && !application.magicLinksEnabled)
      ) {
        throw new AuthenticationServiceError("feature_disabled");
      }
      const user = await stores.users.get(application.id, input.userId);
      if (!user) throw new AuthenticationServiceError("unknown_credential");
      const authConfiguration = configuration(
        application,
        input.purpose ?? "sign-in",
      );
      const ttl =
        input.timeToLiveSeconds ?? authConfiguration.timeToLiveSeconds;
      const now = clock();
      const token = randomToken("ost_");
      const expiresAt = new Date(now.getTime() + ttl * 1_000);
      await stores.oneTime.signin.create(
        {
          tokenHash: hashAuthenticationToken(token),
          applicationId: application.id,
          userId: user.userId,
          purpose: authConfiguration.purpose,
          type: tokenType,
          expiresAt,
        },
        now,
      );
      return { token, expiresAt };
    },

    async setAliases(input: {
      applicationId: string;
      userId: string;
      aliases: string[];
      hashing?: boolean;
    }) {
      const application = await activeApplication(input.applicationId);
      const user = await stores.users.get(application.id, input.userId);
      if (!user) throw new AuthenticationServiceError("unknown_credential");
      const aliases = [
        ...new Set(
          input.aliases.map((alias) =>
            storedAlias(alias, input.hashing ?? true),
          ),
        ),
      ];
      await stores.users.put({ ...user, updatedAt: clock() }, aliases);
    },

    async listCredentials(applicationId: string, userId: string) {
      await activeApplication(applicationId);
      const user = await stores.users.get(applicationId, userId);
      if (!user) throw new AuthenticationServiceError("unknown_credential");
      return stores.credentials.listByUser(applicationId, userId);
    },

    async verifyToken(applicationId: string, token: string) {
      await activeApplication(applicationId);
      const verified = await stores.oneTime.signin.consume(
        hashAuthenticationToken(token),
        clock(),
      );
      if (!verified || verified.applicationId !== applicationId) {
        throw new AuthenticationServiceError("invalid_token");
      }
      return {
        success: true as const,
        userId: verified.userId,
        purpose: verified.purpose,
        type: verified.type,
        aliases: (
          await stores.users.aliases(applicationId, verified.userId)
        ).flatMap((alias) => {
          const visible = visibleAuthenticationAlias(alias);
          return visible ? [visible] : [];
        }),
      };
    },
  };
}

export type AuthenticationService = ReturnType<
  typeof createAuthenticationService
>;
