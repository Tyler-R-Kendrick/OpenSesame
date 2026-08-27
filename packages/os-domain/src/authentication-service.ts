/** A relying-party application served by OpenSesame Authentication Service. */
export interface AuthenticationApplication {
  id: string;
  ownerPrincipalId: string;
  organizationId?: string;
  displayName: string;
  rpId: string;
  origins: string[];
  secretHash: string;
  secretPrefix: string;
  apiKeys: AuthenticationApplicationKey[];
  configurations: AuthenticationConfiguration[];
  manualTokensEnabled: boolean;
  magicLinksEnabled: boolean;
  state: "active" | "suspended" | "revoked";
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthenticationApplicationKey {
  id: string;
  secretHash: string;
  secretPrefix: string;
  state: "active" | "locked";
  createdAt: string;
}

export interface AuthenticationConfiguration {
  purpose: string;
  timeToLiveSeconds: number;
  userVerification: "discouraged" | "preferred" | "required";
  hints: Array<"client-device" | "hybrid" | "security-key">;
}

/** Application-local user. `userId` is chosen by the integrating backend. */
export interface AuthenticationUser {
  applicationId: string;
  userId: string;
  userName: string;
  displayName: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthenticationAlias {
  applicationId: string;
  alias: string;
  userId: string;
}

/** Public WebAuthn material only. Authenticators retain every private key. */
export interface AuthenticationCredential {
  applicationId: string;
  credentialId: string;
  userId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  name?: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt?: Date;
}

export type AuthenticationChallengePurpose = "registration" | "authentication";

export interface AuthenticationChallenge {
  challenge: string;
  applicationId: string;
  purpose: AuthenticationChallengePurpose;
  authenticationPurpose?: string;
  requireUserVerification: boolean;
  origin: string;
  userId?: string;
  registrationTokenHash?: string;
  expiresAt: Date;
}

export interface AuthenticationRegistrationToken {
  tokenHash: string;
  applicationId: string;
  userId: string;
  userName: string;
  displayName: string;
  aliases: string[];
  aliasHashing: boolean;
  authenticatorAttachment?: "cross-platform" | "platform";
  userVerification: "discouraged" | "preferred" | "required";
  expiresAt: Date;
  consumedAt?: Date;
}

export interface AuthenticationSigninToken {
  tokenHash: string;
  applicationId: string;
  userId: string;
  purpose: string;
  type: "magic_link" | "manual" | "passkey";
  expiresAt: Date;
  consumedAt?: Date;
}

export interface AuthenticationApplicationStore {
  create(
    application: AuthenticationApplication,
  ): Promise<AuthenticationApplication>;
  get(id: string): Promise<AuthenticationApplication | undefined>;
  listByOwner(principalId: string): Promise<AuthenticationApplication[]>;
  listByOrganization(
    organizationId: string,
  ): Promise<AuthenticationApplication[]>;
  update(
    application: AuthenticationApplication,
  ): Promise<AuthenticationApplication>;
}

export interface AuthenticationUserStore {
  put(user: AuthenticationUser, aliases: string[]): Promise<AuthenticationUser>;
  get(
    applicationId: string,
    userId: string,
  ): Promise<AuthenticationUser | undefined>;
  findByAlias(
    applicationId: string,
    alias: string,
  ): Promise<AuthenticationUser | undefined>;
  aliases(applicationId: string, userId: string): Promise<string[]>;
  list(applicationId: string): Promise<AuthenticationUser[]>;
}

export interface AuthenticationCredentialStore {
  create(
    credential: AuthenticationCredential,
  ): Promise<AuthenticationCredential>;
  get(
    applicationId: string,
    credentialId: string,
  ): Promise<AuthenticationCredential | undefined>;
  listByUser(
    applicationId: string,
    userId: string,
  ): Promise<AuthenticationCredential[]>;
  rename(
    applicationId: string,
    credentialId: string,
    name: string | undefined,
    at: Date,
  ): Promise<boolean>;
  remove(applicationId: string, credentialId: string): Promise<boolean>;
  recordUse(
    applicationId: string,
    credentialId: string,
    expectedCounter: number,
    nextCounter: number,
    at: Date,
  ): Promise<boolean>;
}

export interface AuthenticationOneTimeStore {
  registration: {
    create(token: AuthenticationRegistrationToken, now?: Date): Promise<void>;
    get(
      tokenHash: string,
    ): Promise<AuthenticationRegistrationToken | undefined>;
    consume(
      tokenHash: string,
      now: Date,
    ): Promise<AuthenticationRegistrationToken | undefined>;
  };
  challenges: {
    create(challenge: AuthenticationChallenge, now?: Date): Promise<void>;
    consume(
      challenge: string,
      now: Date,
    ): Promise<AuthenticationChallenge | undefined>;
  };
  signin: {
    create(token: AuthenticationSigninToken, now?: Date): Promise<void>;
    consume(
      tokenHash: string,
      now: Date,
    ): Promise<AuthenticationSigninToken | undefined>;
  };
}

export interface AuthenticationServiceStores {
  applications: AuthenticationApplicationStore;
  users: AuthenticationUserStore;
  credentials: AuthenticationCredentialStore;
  oneTime: AuthenticationOneTimeStore;
  completeRegistration(input: {
    tokenHash: string;
    now: Date;
    user: AuthenticationUser;
    aliases: string[];
    credential: AuthenticationCredential;
  }): Promise<boolean>;
}
