/**
 * Google Wallet configuration, parsed once and refused loudly.
 *
 * Wallet configuration has an unusual failure mode. Every other half-configured
 * subsystem in this repository fails on its first call and somebody notices
 * inside a minute. A half-configured wallet *appears* to work: the save link is
 * built by signing local JSON, so it is produced happily with a wrong issuer id
 * or a stale class, and the only symptom is that a human — usually one standing
 * in front of a locked door — taps the button and gets an opaque Google error
 * page. By then the fault is hours old and nowhere near the code that caused it.
 *
 * So this parser has one rule: **all of it, or none of it.** An empty
 * environment yields `{ enabled: false }`, which is a supported deployment.
 * A complete environment yields a validated config. Anything in between is a
 * typed error at startup, naming exactly which variables are missing, because
 * a partially configured wallet is a misconfiguration that would otherwise be
 * discovered by a person rather than by a process.
 *
 * There is no bundled default for any of these values, and in particular no
 * default private key. A committed key would be a published key; a "development"
 * key would be a published key that people put into production. The parser only
 * ever reads what the environment supplies.
 */

/** Environment variable names, in the repository's `OPENSESAME_` namespace. */
export const GOOGLE_WALLET_ENV = {
  issuerId: "OPENSESAME_WALLET_GOOGLE_ISSUER_ID",
  classId: "OPENSESAME_WALLET_GOOGLE_CLASS_ID",
  serviceAccountEmail: "OPENSESAME_WALLET_GOOGLE_SERVICE_ACCOUNT_EMAIL",
  serviceAccountKeyPem: "OPENSESAME_WALLET_GOOGLE_SERVICE_ACCOUNT_KEY",
  publicBaseUrl: "OPENSESAME_WALLET_GOOGLE_PUBLIC_BASE_URL",
  origins: "OPENSESAME_WALLET_GOOGLE_ORIGINS",
} as const;

/** The wallet is off, and that is a legitimate way to run. */
export interface GoogleWalletDisabled {
  enabled: false;
}

export interface GoogleWalletEnabled {
  enabled: true;
  /** Google-assigned issuer id. Numeric, and not a secret. */
  issuerId: string;
  /** Fully qualified `{issuerId}.{suffix}` class id. */
  classId: string;
  serviceAccountEmail: string;
  /** PKCS#8 PEM. The only secret in this structure. */
  serviceAccountKeyPem: string;
  /** Origin the canonical interaction URLs must live under. */
  publicBaseUrl: string;
  /** Origins permitted to present the Save link, for the JWT `origins` claim. */
  origins: readonly string[];
}

export type GoogleWalletConfig = GoogleWalletDisabled | GoogleWalletEnabled;

/** Configuration that cannot be used as given. Thrown at startup, never later. */
export class WalletConfigError extends Error {
  readonly variables: readonly string[];
  constructor(detail: string, variables: readonly string[]) {
    super(detail);
    this.name = "WalletConfigError";
    this.variables = variables;
  }
}

/** A source of configuration. `process.env` in production, a literal in tests. */
export interface WalletEnvSource {
  readonly [name: string]: string | undefined;
}

function read(env: WalletEnvSource, name: string): string {
  return (env[name] ?? "").trim();
}

/**
 * Normalize a PEM that travelled through an environment variable.
 *
 * A PKCS#8 key is multi-line and most secret stores, `.env` loaders, and
 * container orchestrators either preserve the newlines or replace them with the
 * two characters `\` and `n`. Accepting both is not laxity: the alternative is
 * an operator silently pasting the escaped form, the key failing to import, and
 * the resulting error pointing at signing rather than at configuration.
 */
function normalizePem(raw: string): string {
  return raw.includes("-----BEGIN") ? raw.replace(/\\n/gu, "\n") : raw;
}

/**
 * Compose the fully qualified class id.
 *
 * Google class ids are `{issuerId}.{suffix}` and operators reliably supply
 * whichever half they happened to be looking at in the Business Console. Both
 * are accepted; a *different* issuer's prefix is not, because issuing objects
 * against another issuer's class is the one mistake here that produces passes
 * belonging to somebody else.
 */
function qualifyClassId(issuerId: string, raw: string): string {
  const dot = raw.indexOf(".");
  if (dot < 0) return `${issuerId}.${raw}`;
  const prefix = raw.slice(0, dot);
  if (prefix !== issuerId) {
    throw new WalletConfigError(
      `${GOOGLE_WALLET_ENV.classId} names issuer "${prefix}" but ${GOOGLE_WALLET_ENV.issuerId} is "${issuerId}"; a class must belong to its own issuer.`,
      [GOOGLE_WALLET_ENV.classId, GOOGLE_WALLET_ENV.issuerId],
    );
  }
  return raw;
}

/**
 * Reject a base URL that could carry anything but a path.
 *
 * The interaction URL is built against this origin and ends up inside a
 * barcode. A base URL with userinfo would put credentials there; one with a
 * query or fragment would put whatever the operator left in it there; and one
 * on plain http would put the whole interaction on the wire in clear.
 */
function requireHttpsBase(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WalletConfigError(`${name} is not a URL.`, [name]);
  }
  if (url.protocol !== "https:") {
    throw new WalletConfigError(`${name} must use https.`, [name]);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WalletConfigError(`${name} must not carry credentials.`, [name]);
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new WalletConfigError(
      `${name} must be a bare origin and path, with no query or fragment.`,
      [name],
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

function parseOrigins(raw: string): readonly string[] {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new WalletConfigError(
      `${GOOGLE_WALLET_ENV.origins} is set but lists no origins.`,
      [GOOGLE_WALLET_ENV.origins],
    );
  }
  return entries.map((entry) => {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new WalletConfigError(
        `${GOOGLE_WALLET_ENV.origins} entry "${entry}" is not a URL.`,
        [GOOGLE_WALLET_ENV.origins],
      );
    }
    if (url.protocol !== "https:") {
      throw new WalletConfigError(
        `${GOOGLE_WALLET_ENV.origins} entry "${entry}" must use https.`,
        [GOOGLE_WALLET_ENV.origins],
      );
    }
    // Google matches the `origins` claim against the page that presents the
    // Save link, and an origin is scheme, host, and port — nothing else. A
    // path here is silently ignored by Google, which makes it an operator
    // belief that never comes true.
    if (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) {
      throw new WalletConfigError(
        `${GOOGLE_WALLET_ENV.origins} entry "${entry}" must be a bare origin.`,
        [GOOGLE_WALLET_ENV.origins],
      );
    }
    return url.origin;
  });
}

/**
 * Parse the Google Wallet configuration out of an environment.
 *
 * Returns `{ enabled: false }` only when *nothing* is set. Throws
 * `WalletConfigError` for every other incomplete or malformed combination.
 */
export function parseGoogleWalletConfig(
  env: WalletEnvSource,
): GoogleWalletConfig {
  const names = Object.values(GOOGLE_WALLET_ENV);
  const present = names.filter((name) => read(env, name).length > 0);
  if (present.length === 0) return { enabled: false };

  const missing = names.filter((name) => read(env, name).length === 0);
  if (missing.length > 0) {
    throw new WalletConfigError(
      `Google Wallet is partially configured: ${present.join(", ")} set, ${missing.join(", ")} missing. Set all of them or none of them.`,
      missing,
    );
  }

  const issuerId = read(env, GOOGLE_WALLET_ENV.issuerId);
  // Google issuer ids are numeric. Checking that here turns "somebody pasted
  // the class id into the issuer slot" into a startup error rather than a
  // rejected save link that a human discovers at the door.
  if (!/^\d{6,32}$/u.test(issuerId)) {
    throw new WalletConfigError(
      `${GOOGLE_WALLET_ENV.issuerId} must be the numeric Google-assigned issuer id.`,
      [GOOGLE_WALLET_ENV.issuerId],
    );
  }

  const classSuffixSource = read(env, GOOGLE_WALLET_ENV.classId);
  const classId = qualifyClassId(issuerId, classSuffixSource);
  const suffix = classId.slice(issuerId.length + 1);
  if (!/^[A-Za-z0-9._-]+$/u.test(suffix)) {
    throw new WalletConfigError(
      `${GOOGLE_WALLET_ENV.classId} suffix may only contain letters, digits, ".", "_" and "-".`,
      [GOOGLE_WALLET_ENV.classId],
    );
  }

  const serviceAccountEmail = read(
    env,
    GOOGLE_WALLET_ENV.serviceAccountEmail,
  ).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(serviceAccountEmail)) {
    throw new WalletConfigError(
      `${GOOGLE_WALLET_ENV.serviceAccountEmail} must be the service account's client email address.`,
      [GOOGLE_WALLET_ENV.serviceAccountEmail],
    );
  }

  const serviceAccountKeyPem = normalizePem(
    read(env, GOOGLE_WALLET_ENV.serviceAccountKeyPem),
  );
  if (/-----BEGIN RSA PRIVATE KEY-----/u.test(serviceAccountKeyPem)) {
    // PKCS#1. Google's own service-account JSON ships PKCS#8, so seeing this
    // means the key was converted somewhere; say so instead of failing later
    // inside a JOSE import with a message about ASN.1.
    throw new WalletConfigError(
      `${GOOGLE_WALLET_ENV.serviceAccountKeyPem} is a PKCS#1 key; supply the PKCS#8 "BEGIN PRIVATE KEY" form from the service account JSON.`,
      [GOOGLE_WALLET_ENV.serviceAccountKeyPem],
    );
  }
  if (!/^-----BEGIN PRIVATE KEY-----/u.test(serviceAccountKeyPem)) {
    throw new WalletConfigError(
      `${GOOGLE_WALLET_ENV.serviceAccountKeyPem} must be a PKCS#8 PEM private key.`,
      [GOOGLE_WALLET_ENV.serviceAccountKeyPem],
    );
  }

  const publicBaseUrl = requireHttpsBase(
    GOOGLE_WALLET_ENV.publicBaseUrl,
    read(env, GOOGLE_WALLET_ENV.publicBaseUrl),
  );
  const origins = parseOrigins(read(env, GOOGLE_WALLET_ENV.origins));

  return {
    enabled: true,
    issuerId,
    classId,
    serviceAccountEmail,
    serviceAccountKeyPem,
    publicBaseUrl,
    origins,
  };
}
