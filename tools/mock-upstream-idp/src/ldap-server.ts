import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { overlapCast } from "@opensesame/os-domain";

/**
 * The reference directory: a REAL in-process LDAP server (ADR 0057, C18/C21).
 *
 * The LDAP bind leg and the directory sync are protocol code, so their tests
 * talk to a genuine LDAP server over a real socket — BER-encoded requests, real
 * bind and search operations, real result codes — rather than to a stubbed
 * client. Nothing here is a fixture file: callers build the tree at runtime and
 * the server forgets it on close (T19).
 *
 * `ldapjs` is a **devDependency of this package only** (T34). Upstream is
 * sunset but protocol-complete, and it is the only maintained-enough Node LDAP
 * *server*; the runtime client on the control-plane side is `ldapts`. It must
 * never appear in a runtime dependency list — this module is imported by tests
 * and by the dev stack's reference IdP, never by the published server.
 *
 * INTEGRATOR / S8: this file is S12's contribution to the reference IdP
 * package. `startReferenceIdp` can grow a `protocol: "ldap"` mode by calling
 * `startReferenceLdapServer()` alongside the HTTP listener and surfacing
 * `{ url, baseDn }` on the returned handle; nothing here depends on the HTTP
 * server, so the wiring is additive.
 */

/** A directory entry. `password` makes the entry bindable. */
export type ReferenceLdapEntry = {
  dn: string;
  password?: string;
  attributes: Record<string, string[]>;
};

export type ReferenceLdapServerOptions = {
  /** Root of the served tree. Default `dc=acme,dc=example`. */
  baseDn?: string;
  entries?: ReferenceLdapEntry[];
  /** Bind a fixed port instead of an ephemeral one. */
  port?: number;
};

export type ReferenceLdapServer = {
  /** `ldap://127.0.0.1:<port>` — the URL an org config would carry. */
  url: string;
  port: number;
  baseDn: string;
  /** Add or replace an entry. Fixtures are built at runtime, never committed. */
  putEntry(entry: ReferenceLdapEntry): void;
  /** Remove an entry — how a test makes somebody a leaver. */
  removeEntry(dn: string): boolean;
  /**
   * Every DN this server was asked to bind, in order. Credentials are
   * deliberately NOT recorded: a test helper that kept passwords around would
   * be the same mistake the leg is forbidden to make.
   */
  bindAttempts(): string[];
  close(): Promise<void>;
};

/*
 * The slice of the `ldapjs` server API this file uses. Upstream ships no type
 * declarations, so the surface is declared here rather than pulling in another
 * dependency; `createRequire` keeps the CommonJS import honest under
 * NodeNext + verbatimModuleSyntax.
 */
type LdapDn = { toString(): string };

type LdapFilter = {
  toString(): string;
  matches(attributes: Record<string, string[] | string>): boolean;
};

type LdapBindRequest = { dn: LdapDn; credentials?: string };

/** `scopeName` is ldapjs's spelling: `base` | `single` | `subtree`. */
type LdapSearchScope = "base" | "single" | "subtree";

type LdapSearchRequest = {
  dn: LdapDn;
  filter: LdapFilter;
  scopeName: LdapSearchScope;
};

type LdapSearchEntry = { dn: string; attributes: Record<string, string[]> };

type LdapResponse = { end(): void };

type LdapSearchResponse = LdapResponse & {
  send(entry: LdapSearchEntry): void;
  /** The attribute list the client asked for, as ldapjs filters replies by. */
  attributes: string[];
};

type LdapNext = (error?: Error) => void;

type LdapServer = {
  bind(
    dn: string,
    handler: (req: LdapBindRequest, res: LdapResponse, next: LdapNext) => void,
  ): void;
  search(
    dn: string,
    handler: (
      req: LdapSearchRequest,
      res: LdapSearchResponse,
      next: LdapNext,
    ) => void,
  ): void;
  listen(port: number, host: string, callback: () => void): void;
  close(callback: (error?: Error) => void): void;
  address(): AddressInfo | null;
};

type LdapErrorConstructor = new (message?: string) => Error;

type LdapjsModule = {
  createServer(): LdapServer;
  InvalidCredentialsError: LdapErrorConstructor;
  NoSuchObjectError: LdapErrorConstructor;
  UnwillingToPerformError: LdapErrorConstructor;
};

const requireCjs = createRequire(import.meta.url);

function loadLdapjs(): LdapjsModule {
  // SAFETY: ldapjs is CommonJS and ships no declarations; the shape asserted
  // here is the documented server API and is exercised by every test in this
  // repository that starts a directory.
  return overlapCast(requireCjs("ldapjs"));
}

const DEFAULT_BASE_DN = "dc=acme,dc=example";

function normalizeDn(dn: string): string {
  return dn.trim().toLowerCase().replace(/,\s+/g, ",");
}

/** DNs at or under `base`, per the requested search scope. */
function inScope(
  entryDn: string,
  baseDn: string,
  scope: LdapSearchScope,
): boolean {
  const entry = normalizeDn(entryDn);
  const base = normalizeDn(baseDn);
  if (entry === base) return scope === "base" || scope === "subtree";
  if (!entry.endsWith(`,${base}`)) return false;
  if (scope === "base") return false;
  if (scope === "single") {
    return !entry.slice(0, entry.length - base.length - 1).includes(",");
  }
  return true;
}

export async function startReferenceLdapServer(
  options: ReferenceLdapServerOptions = {},
): Promise<ReferenceLdapServer> {
  const ldapjs = loadLdapjs();
  const baseDn = options.baseDn ?? DEFAULT_BASE_DN;
  const entries = new Map<string, ReferenceLdapEntry>();
  const attempts: string[] = [];

  function putEntry(entry: ReferenceLdapEntry): void {
    entries.set(normalizeDn(entry.dn), {
      dn: entry.dn,
      attributes: entry.attributes,
      ...(entry.password !== undefined
        ? { password: entry.password }
        : undefined),
    });
  }

  for (const entry of options.entries ?? []) putEntry(entry);

  const server = ldapjs.createServer();

  /*
   * A real bind. Unknown DNs answer `noSuchObject` and wrong passwords answer
   * `invalidCredentials` — deliberately DIFFERENT result codes, because that is
   * what several real directories do and it is exactly the oracle the client
   * side must refuse to pass on (T34). The uniformity has to be proven at the
   * OpenSesame boundary, not donated by the server.
   */
  server.bind(baseDn, (req, res, next) => {
    const dn = normalizeDn(req.dn.toString());
    attempts.push(dn);
    const entry = entries.get(dn);
    if (!entry) {
      next(new ldapjs.NoSuchObjectError(dn));
      return;
    }
    if (entry.password === undefined) {
      next(new ldapjs.UnwillingToPerformError("entry is not bindable"));
      return;
    }
    if (req.credentials !== entry.password) {
      next(new ldapjs.InvalidCredentialsError("invalid credentials"));
      return;
    }
    res.end();
    next();
  });

  server.search(baseDn, (req, res, next) => {
    const searchBase = req.dn.toString();
    /*
     * Attribute descriptions are case-insensitive (RFC 4512 §2.5) and every
     * real directory treats them so — `entryUUID` and `entryuuid` name the
     * same attribute. ldapjs's reply filter compares the client's list
     * verbatim against lowercased attribute names, which silently blanks any
     * camelCase attribute a client asks for by its documented spelling.
     * Lowercasing the requested list restores the behavior a real server has.
     */
    res.attributes = res.attributes.map((attribute) => attribute.toLowerCase());
    for (const entry of entries.values()) {
      if (!inScope(entry.dn, searchBase, req.scopeName)) continue;
      if (!req.filter.matches(entry.attributes)) continue;
      // A copy: ldapjs deletes filtered keys from the object it is handed and
      // restores them after the write, which would otherwise mutate the tree.
      res.send({ dn: entry.dn, attributes: { ...entry.attributes } });
    }
    res.end();
    next();
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  // The pipe/string form of address() is unreachable for a host+port listen.
  const port = server.address()?.port ?? 0;
  if (port === 0) throw new Error("reference LDAP server bound no TCP port");

  return {
    url: `ldap://127.0.0.1:${port}`,
    port,
    baseDn,
    putEntry,
    removeEntry: (dn: string) => entries.delete(normalizeDn(dn)),
    bindAttempts: () => [...attempts],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
