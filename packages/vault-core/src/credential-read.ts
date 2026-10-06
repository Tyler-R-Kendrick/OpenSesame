/**
 * What a credential shows and gives (ADR 0177): its list subtitle and search
 * words, the fields its type declares, what copying it puts on the clipboard,
 * and a new empty method of a type.
 */

import { apiKeyHeaderLine, bearerHeaderLine } from "./account-lines.js";
import {
  DEFAULT_RULES,
  type LoginMethod,
  type LoginMethodType,
  type OAuthMethod,
  type PasswordGeneratorId,
  newMethodId,
} from "./account.js";
import { type CredentialItem, credentialTypeLabel } from "./credential.js";
import { mintRootSecret } from "./derive.js";
import { filePassword, handoff, producePassword } from "./produce.js";

const GENERATOR_WORDS = {
  derived: "Algorithmic",
  rules: "Random",
  passphrase: "Passphrase",
  manual: "Typed",
  sphinx: "Earlier algorithm",
} satisfies Record<PasswordGeneratorId, string>;

/** What a list row says under a credential's name. Never a value. */
export function credentialSubtitle(item: CredentialItem): string {
  const { method } = item;
  const detail = (() => {
    switch (method.type) {
      case "password":
        return GENERATOR_WORDS[method.generator.id];
      case "api-key":
        return method.header.trim();
      case "token":
        return method.expiresAt === ""
          ? ""
          : `until ${method.expiresAt.slice(0, 10)}`;
      case "oauth":
        return method.clientId;
      case "authenticator":
        return "";
    }
  })();
  const kind = credentialTypeLabel(method.type);
  const head = detail === "" ? kind : `${kind} · ${detail}`;
  return item.accountId === null ? `${head} · not bound` : head;
}

/** Plain words a search may match; never a value a credential keeps. */
export function credentialSearchText(item: CredentialItem): string[] {
  const { method } = item;
  const label = credentialTypeLabel(method.type);
  if (method.type === "api-key") return [label, method.header];
  if (method.type === "oauth") return [label, method.clientId, method.tokenUrl];
  return [label];
}

/**
 * A credential's declared fields (the manifests name them) read off its method.
 * A password an algorithm computes is not a value a file holds (ADR 0174): it
 * reads as absent.
 */
export function credentialField(
  item: CredentialItem,
  id: string,
): string | undefined {
  const { method } = item;
  const value = (() => {
    switch (method.type) {
      case "password":
        return id === "password" ? filePassword(method) : undefined;
      case "api-key":
        return id === "apiKey"
          ? method.key
          : id === "header"
            ? method.header
            : undefined;
      case "token":
        return id === "token"
          ? method.token
          : id === "expiresAt"
            ? method.expiresAt
            : undefined;
      case "oauth":
        return oauthField(method, id);
      case "authenticator":
        return id === "totp" ? method.secret : undefined;
    }
  })();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * What copying a credential puts on the clipboard: a password as the facade
 * hands it over, an API key as the header line to paste into a request, a token
 * as a bearer line. Null when there is nothing to copy, an authenticator's seed
 * included: a code is made from it, never copied.
 */
export function credentialConcealed(item: CredentialItem): string | null {
  const { method } = item;
  switch (method.type) {
    case "password": {
      const out = handoff(producePassword(method));
      return out !== null && out.later === "" && out.now !== ""
        ? out.now
        : null;
    }
    case "api-key":
      return method.key.trim() === ""
        ? null
        : apiKeyHeaderLine(method.header, method.key);
    case "token":
      return method.token.trim() === "" ? null : bearerHeaderLine(method.token);
    case "oauth":
      return method.clientSecret === "" ? null : method.clientSecret;
    case "authenticator":
      return null;
  }
}

/** A new, empty method of a type. A password starts algorithmic, with a fresh root. */
export function newLoginMethod(
  type: LoginMethodType,
  owner: string,
  now: Date = new Date(),
): LoginMethod {
  const id = newMethodId(owner, type);
  switch (type) {
    case "password":
      return {
        id,
        type,
        generator: { id: "derived", rules: { ...DEFAULT_RULES }, counter: 0 },
        pepper: true,
        secret: mintRootSecret(),
        changedAt: now.toISOString(),
      };
    case "api-key":
      return { id, type, key: "", header: "X-Api-Key" };
    case "token":
      return { id, type, token: "", expiresAt: "" };
    case "oauth":
      return {
        id,
        type,
        clientId: "",
        clientSecret: "",
        tokenUrl: "",
        scopes: "",
        refreshToken: "",
      };
    case "authenticator":
      return { id, type, secret: "" };
  }
}

function oauthField(method: OAuthMethod, id: string): string | undefined {
  switch (id) {
    case "clientId":
      return method.clientId;
    case "clientSecret":
      return method.clientSecret;
    case "tokenUrl":
      return method.tokenUrl;
    case "scopes":
      return method.scopes;
    case "refreshToken":
      return method.refreshToken;
    default:
      return undefined;
  }
}
