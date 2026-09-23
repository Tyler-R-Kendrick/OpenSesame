import type { LookupAddress, LookupOptions } from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { resolveSafeMetadataAddresses } from "@opensesame/oauth-provider/metadata/safe-fetcher";
import { type OrgLdapConfig, overlapCast } from "@opensesame/os-domain";
import { Client, type ClientOptions } from "ldapts";
import { guardedFetchSeams } from "../services/guarded-fetch.js";

/**
 * The resolve-time half of the LDAP host fence (T21).
 *
 * `assertUsableLdapConfig` judges the directory URL as written, which stops
 * `ldaps://169.254.169.254` but not `ldaps://dir.attacker.example` whose DNS
 * answer is `10.0.0.1`. An org owner is trusted with their tenant, not with
 * this server's network position, so every socket the LDAP client opens is
 * given a `lookup` that resolves the name, refuses the connection if ANY
 * address is private or special (the same policy `guardedFetch` applies), and
 * hands back only the addresses it judged. The socket therefore dials exactly
 * what was checked, and TLS still verifies the certificate against the name.
 *
 * Skipped under dev defaults, where the reference directory is loopback.
 */

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

function wantedFamily(options: LookupOptions): 0 | 4 | 6 {
  if (options.family === 4 || options.family === "IPv4") return 4;
  if (options.family === 6 || options.family === "IPv6") return 6;
  return 0;
}

/** The addresses a directory name may be dialled at; throws when none. */
async function fencedAddresses(
  hostname: string,
  options: LookupOptions,
): Promise<LookupAddress[]> {
  const host = net.isIPv6(hostname) ? `[${hostname}]` : hostname;
  let addresses: string[];
  try {
    addresses = await resolveSafeMetadataAddresses(
      new URL(`https://${host}`),
      guardedFetchSeams.lookup,
    );
  } catch (error) {
    throw error instanceof Error ? error : new Error("Directory host refused");
  }
  const wanted = wantedFamily(options);
  const records = addresses
    .map((address) => ({ address, family: net.isIP(address) }))
    .filter((record) => wanted === 0 || record.family === wanted);
  if (records.length === 0) {
    throw new Error(`No usable address for ${hostname}`);
  }
  return records;
}

function fencedLookup(
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
): void {
  fencedAddresses(hostname, options).then(
    (records) => {
      const [first] = records;
      if (options.all || !first) callback(null, records);
      else callback(null, first.address, first.family);
    },
    (error: Error) => callback(error, "", 0),
  );
}

/** Socket factories for `ldapts` that dial through {@link fencedLookup}. */
function fencedConnections(): Pick<
  ClientOptions,
  "createConnection" | "createSecureConnection"
> {
  // SAFETY: ldapts calls these as `(port, host)`, `(port, host, tlsOptions)`
  // and, for StartTLS, `(options)` (ldapts 9 `Client`); `typeof net.connect`
  // is an overload set no single arrow can be assigned to without a cast.
  return overlapCast({
    createConnection: (port: number, host: string) =>
      net.connect({ port, host, lookup: fencedLookup }),
    createSecureConnection: (
      port: number | tls.ConnectionOptions,
      host?: string,
      options?: tls.ConnectionOptions,
    ) =>
      // StartTLS upgrades a socket this factory already fenced.
      port instanceof Object
        ? tls.connect(port)
        : tls.connect({ ...options, port, host, lookup: fencedLookup }),
  });
}

/** A directory config the bind path may dial, fenced unless under dev. */
export type LdapTarget = OrgLdapConfig & {
  readonly connections?: ReturnType<typeof fencedConnections>;
};

export function fencedLdapTarget(
  allowDevDefaults: boolean,
  config: OrgLdapConfig,
): LdapTarget {
  return allowDevDefaults
    ? config
    : { ...config, connections: fencedConnections() };
}

/** Directory round-trips are interactive; five seconds is already generous. */
const LDAP_TIMEOUT_MS = 5_000;

/** An `ldapts` client for `config`, dialling through the fence when set. */
export function createClient(config: LdapTarget): Client {
  return new Client({
    url: config.url,
    timeout: LDAP_TIMEOUT_MS,
    connectTimeout: LDAP_TIMEOUT_MS,
    ...config.connections,
  });
}
