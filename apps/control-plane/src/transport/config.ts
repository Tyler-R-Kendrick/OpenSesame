/**
 * Identity-plane transport configuration (CONTRACT §5).
 *
 * Reads `OPENSESAME_TLS_*`, `OPENSESAME_SERVICE_BINDINGS_FILE`,
 * `OPENSESAME_MAPPING_AUTH` and `OPENSESAME_INGRESS_ORIGINATING_TRUST_FILE`.
 * Parsing never touches the filesystem; {@link loadTransportMaterial} does,
 * and it is what `assertSecureConfig` runs so a configured listener with
 * missing or mismatched material refuses the boot instead of falling back
 * to plain HTTP (EXPLICIT-ENFORCEMENT).
 */
import { type KeyObject, X509Certificate, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { loopbackHost } from "../deployment-mode.js";
import type { TlsVersion, TransportPolicy } from "./peer-evidence.js";
import {
  EMPTY_BINDINGS,
  type ServiceBindingSet,
  parseServiceBindings,
} from "./service-admission.js";

export type ListenerPolicy = Exclude<TransportPolicy, "existing_local">;
export type MappingAuthMode = "shared_secret" | "mtls";

export interface TransportListenerConfig {
  host: string;
  port: number;
  policy: ListenerPolicy;
  certFile: string;
  keyFile: string;
  clientCaFile?: string;
  minVersion: TlsVersion;
  /** Name the bindings' `trust_profile` refers to for this listener's client CA. */
  trustProfile: string;
  serviceBindingsFile?: string;
  ingressOriginatingTrustFile?: string;
  /**
   * Public base of this listener when it is reachable at a different URL
   * than the issuer. Only then does discovery advertise
   * `mtls_endpoint_aliases`, because only then are the aliased endpoints
   * actually served on the TLS listener at an address a client can name.
   */
  publicUrl?: string;
}

export interface TransportConfig {
  listener?: TransportListenerConfig;
  mappingAuth: MappingAuthMode;
  /** True when `OPENSESAME_MAPPING_AUTH` was set explicitly. */
  mappingAuthExplicit: boolean;
}

export interface TransportMaterial {
  certPem: string;
  /** PEM as read; validated against the leaf before it reaches the listener. */
  keyPem: string;
  leaf: X509Certificate;
  clientCaPem?: string;
  clientCa: X509Certificate[];
  bindings: ServiceBindingSet;
  ingressTrustPem?: string;
  ingressTrust: X509Certificate[];
}

const POLICIES: ReadonlySet<string> = new Set([
  "server_tls",
  "mtls_required",
  "trusted_ingress",
]);

/** True when a bind host is loopback (matches Rust host-core daemon policy). */
export function listenHostIsLoopback(host: string): boolean {
  return loopbackHost(host);
}

/** Refuse non-loopback listen unless OPENSESAME_ALLOW_NONLOCAL=1. */
export function assertListenHostAllowed(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const allow =
    env.OPENSESAME_ALLOW_NONLOCAL === "1" ||
    env.OPENSESAME_DAEMON_ALLOW_NONLOCAL === "1";
  if (allow || listenHostIsLoopback(host)) return;
  throw new Error(
    `listen host \`${host}\` is not loopback; set OPENSESAME_ALLOW_NONLOCAL=1 to override`,
  );
}

export class TransportConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportConfigError";
  }
}

function parseListen(raw: string): { host: string; port: number } {
  const value = raw.trim();
  const v6 = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(value);
  const v4 = /^([^:\s]+):(\d{1,5})$/.exec(value);
  const match = v6 ?? v4;
  if (!match?.[1] || !match[2]) {
    throw new TransportConfigError(
      "OPENSESAME_TLS_LISTEN must be host:port (or [v6]:port)",
    );
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TransportConfigError("OPENSESAME_TLS_LISTEN port out of range");
  }
  return { host: match[1], port };
}

function nonEmpty(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function parseListenerEnv(
  env: NodeJS.ProcessEnv,
  listen: string,
): TransportListenerConfig {
  const policy = nonEmpty(env, "OPENSESAME_TLS_POLICY");
  if (!policy || !POLICIES.has(policy)) {
    throw new TransportConfigError(
      "OPENSESAME_TLS_POLICY must be server_tls, mtls_required or trusted_ingress when OPENSESAME_TLS_LISTEN is set",
    );
  }
  const certFile = nonEmpty(env, "OPENSESAME_TLS_CERT_FILE");
  const keyFile = nonEmpty(env, "OPENSESAME_TLS_KEY_FILE");
  if (!certFile || !keyFile) {
    throw new TransportConfigError(
      "OPENSESAME_TLS_CERT_FILE and OPENSESAME_TLS_KEY_FILE are required with OPENSESAME_TLS_LISTEN",
    );
  }
  const minRaw = nonEmpty(env, "OPENSESAME_TLS_MIN_VERSION") ?? "1.3";
  if (minRaw !== "1.2" && minRaw !== "1.3") {
    throw new TransportConfigError(
      "OPENSESAME_TLS_MIN_VERSION must be 1.2 or 1.3",
    );
  }
  const listener: TransportListenerConfig = {
    ...parseListen(listen),
    // SAFETY: membership in POLICIES was checked above.
    policy: policy as ListenerPolicy,
    certFile,
    keyFile,
    minVersion: minRaw === "1.2" ? "tls12" : "tls13",
    trustProfile:
      nonEmpty(env, "OPENSESAME_TLS_CLIENT_TRUST_PROFILE") ?? "client_ca",
  };
  const optional: Array<[keyof TransportListenerConfig, string]> = [
    ["clientCaFile", "OPENSESAME_TLS_CLIENT_CA_FILE"],
    ["serviceBindingsFile", "OPENSESAME_SERVICE_BINDINGS_FILE"],
    [
      "ingressOriginatingTrustFile",
      "OPENSESAME_INGRESS_ORIGINATING_TRUST_FILE",
    ],
    ["publicUrl", "OPENSESAME_TLS_PUBLIC_URL"],
  ];
  for (const [field, name] of optional) {
    const value = nonEmpty(env, name);
    if (value) Object.assign(listener, { [field]: value });
  }
  return listener;
}

/**
 * Both a shared secret and a certificate-capable listener with bindings, and
 * no explicit choice, is an ambiguity the deployment must resolve (§5).
 */
function decideMappingAuth(
  rawMapping: string | undefined,
  token: string | undefined,
  listener: TransportListenerConfig | undefined,
): MappingAuthMode {
  if (rawMapping === "mtls" || rawMapping === "shared_secret")
    return rawMapping;
  if (rawMapping !== undefined) {
    throw new TransportConfigError(
      "OPENSESAME_MAPPING_AUTH must be `shared_secret` or `mtls`",
    );
  }
  const certCapable =
    listener !== undefined &&
    listener.policy !== "server_tls" &&
    listener.serviceBindingsFile !== undefined;
  if (token && certCapable) {
    throw new TransportConfigError(
      "OPENSESAME_MAPPING_AUTH must be set when both OPENSESAME_MAPPING_RESOLVE_TOKEN and a service-binding TLS listener are configured",
    );
  }
  return certCapable ? "mtls" : "shared_secret";
}

/** Parse the transport environment. Files are not read here. */
export function loadTransportConfig(env: NodeJS.ProcessEnv): TransportConfig {
  const rawMapping = nonEmpty(env, "OPENSESAME_MAPPING_AUTH");
  const listen = nonEmpty(env, "OPENSESAME_TLS_LISTEN");
  const listener = listen ? parseListenerEnv(env, listen) : undefined;
  const config: TransportConfig = {
    mappingAuth: decideMappingAuth(
      rawMapping,
      nonEmpty(env, "OPENSESAME_MAPPING_RESOLVE_TOKEN"),
      listener,
    ),
    mappingAuthExplicit: rawMapping !== undefined,
  };
  if (listener) config.listener = listener;
  return config;
}

function readPem(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new TransportConfigError(`${what} could not be read`);
  }
}

/** Every CERTIFICATE block in a PEM bundle, in order. */
export function parsePemCertificates(pem: string): X509Certificate[] {
  const blocks = pem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  );
  return (blocks ?? []).map((block) => new X509Certificate(block));
}

function loadServerIdentity(
  listener: TransportListenerConfig,
  now: Date,
): Pick<TransportMaterial, "certPem" | "keyPem" | "leaf"> {
  const certPem = readPem(listener.certFile, "OPENSESAME_TLS_CERT_FILE");
  const leaf = parsePemCertificates(certPem)[0];
  if (!leaf) {
    throw new TransportConfigError(
      "OPENSESAME_TLS_CERT_FILE holds no certificate",
    );
  }
  const keyPem = readPem(listener.keyFile, "OPENSESAME_TLS_KEY_FILE");
  let key: KeyObject;
  try {
    key = createPrivateKey(keyPem);
  } catch {
    throw new TransportConfigError(
      "OPENSESAME_TLS_KEY_FILE is not a private key",
    );
  }
  if (!leaf.checkPrivateKey(key)) {
    throw new TransportConfigError(
      "key_pair_mismatch: OPENSESAME_TLS_KEY_FILE does not match the certificate",
    );
  }
  if (leaf.ca) {
    throw new TransportConfigError(
      "OPENSESAME_TLS_CERT_FILE is a CA certificate, not a server leaf",
    );
  }
  const t = now.getTime();
  if (t < leaf.validFromDate.getTime() || t >= leaf.validToDate.getTime()) {
    throw new TransportConfigError(
      "identity_missing: server certificate is not currently valid",
    );
  }
  return { certPem, keyPem, leaf };
}

/** A PEM bundle that must hold only CA certificates, or nothing when unset. */
function loadTrustBundle(
  path: string | undefined,
  name: string,
  requiredBy: string | undefined,
): { pem?: string; anchors: X509Certificate[] } {
  if (!path) {
    if (requiredBy) {
      throw new TransportConfigError(
        `trust_unknown: ${requiredBy} requires ${name}`,
      );
    }
    return { anchors: [] };
  }
  const pem = readPem(path, name);
  const anchors = parsePemCertificates(pem);
  if (anchors.length === 0 || !anchors.every((c) => c.ca)) {
    throw new TransportConfigError(
      `trust_unknown: ${name} must hold only CA certificates`,
    );
  }
  return { pem, anchors };
}

/**
 * Read and validate the listener's material. Refuses: unreadable files, a
 * key that does not match the certificate, a CA certificate used as the
 * leaf, an expired or not-yet-valid leaf, a client-auth policy without a
 * client CA, and an invalid bindings document.
 */
export function loadTransportMaterial(
  listener: TransportListenerConfig,
  now: Date = new Date(),
): TransportMaterial {
  const identity = loadServerIdentity(listener, now);
  const clientTrust = loadTrustBundle(
    listener.clientCaFile,
    "OPENSESAME_TLS_CLIENT_CA_FILE",
    listener.policy === "server_tls"
      ? undefined
      : `OPENSESAME_TLS_POLICY=${listener.policy}`,
  );
  const ingressTrust = loadTrustBundle(
    listener.ingressOriginatingTrustFile,
    "OPENSESAME_INGRESS_ORIGINATING_TRUST_FILE",
    listener.policy === "trusted_ingress" ? "trusted_ingress" : undefined,
  );
  const material: TransportMaterial = {
    ...identity,
    clientCa: clientTrust.anchors,
    bindings: EMPTY_BINDINGS,
    ingressTrust: ingressTrust.anchors,
  };
  if (clientTrust.pem !== undefined) material.clientCaPem = clientTrust.pem;
  if (ingressTrust.pem !== undefined) {
    material.ingressTrustPem = ingressTrust.pem;
  }
  if (listener.serviceBindingsFile) {
    material.bindings = parseServiceBindings(
      readPem(listener.serviceBindingsFile, "OPENSESAME_SERVICE_BINDINGS_FILE"),
    );
  }
  return material;
}

/**
 * Startup predicate for the mapping receiver (AT-MAPPING-STARTUP):
 * - `shared_secret` in production requires the token (unchanged behaviour);
 * - `mtls` requires a client-authenticating listener with a bindings file and
 *   boots WITHOUT the token — an unused secret is not a requirement.
 * A configured listener also has its material validated here so a missing
 * or mismatched key/cert refuses the boot rather than downgrading.
 */
export function assertTransportSecure(
  transport: TransportConfig | undefined,
  options: { isProduction: boolean; mappingResolveToken: string },
  env: NodeJS.ProcessEnv = process.env,
): void {
  // A hand-assembled partial config (tests) has no transport block: that is
  // the legacy shared-secret profile, not a listener to validate.
  const resolved: TransportConfig = transport ?? {
    mappingAuth: "shared_secret",
    mappingAuthExplicit: false,
  };
  const { listener } = resolved;
  if (listener) assertListenHostAllowed(listener.host, env);
  if (resolved.mappingAuth === "mtls") {
    if (!listener || listener.policy === "server_tls") {
      throw new TransportConfigError(
        "OPENSESAME_MAPPING_AUTH=mtls requires OPENSESAME_TLS_LISTEN with OPENSESAME_TLS_POLICY=mtls_required or trusted_ingress",
      );
    }
    if (!listener.serviceBindingsFile) {
      throw new TransportConfigError(
        "OPENSESAME_MAPPING_AUTH=mtls requires OPENSESAME_SERVICE_BINDINGS_FILE",
      );
    }
  } else if (options.isProduction && !options.mappingResolveToken) {
    throw new Error(
      "OPENSESAME_MAPPING_RESOLVE_TOKEN must be set in production",
    );
  }
  if (listener) loadTransportMaterial(listener);
}
