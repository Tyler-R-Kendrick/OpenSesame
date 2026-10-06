/**
 * An account's login methods as CXF credentials (ADR 0172).
 *
 * - `password` -> `basic-auth`. One per password method, each carrying the
 *   username so a reader that takes the first one still learns it.
 * - `authenticator` -> `totp`.
 * - `api-key` -> `api-key`, the header kept in this vault's extension.
 * - `token` and `oauth` -> `custom-fields`; CXF has no credential for either.
 *
 * A password that is not whole is **withheld**: one an algorithm computes (a
 * file holds the parameters it is computed from, never the generated password,
 * and CXF has no field for them), one missing the pepper only the person has,
 * and one an older version made. The root, the sealed envelope and the OPRF key
 * are never read here. The account keeps a `basic-auth` that names its username
 * and no password at all, so it still arrives as an account, and the count is
 * returned.
 */

import {
  type AccountItem,
  type LoginMethod,
  completePassword,
  isAlgorithmic,
  producePassword,
} from "@opensesame/vault-core";
import {
  CXF_EXTENSION,
  CXF_TYPES,
  type CxfCredential,
  type CxfEditableField,
  field,
} from "./cxf-model.js";

/**
 * TOTP as CXF models it — separate parameters rather than a URI. A vault entry
 * that already holds an `otpauth://` URI keeps it verbatim in an extension, so
 * a document written here and read back here is exact even where CXF's own
 * field set cannot express the original label.
 */
export function totpCredential(
  totp: string,
  username: string,
): CxfCredential | null {
  const raw = totp.trim();
  if (raw === "") return null;
  if (!/^otpauth:\/\//iu.test(raw)) {
    return {
      type: CXF_TYPES.totp,
      secret: raw,
      period: 30,
      digits: 6,
      algorithm: "sha1",
      username,
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // A malformed URI is still the user's data; carry it as the secret rather
    // than dropping a second factor on the floor.
    return {
      type: CXF_TYPES.totp,
      secret: raw,
      period: 30,
      digits: 6,
      algorithm: "sha1",
      username,
    };
  }
  const params = url.searchParams;
  const algorithm = (params.get("algorithm") ?? "sha1").toLowerCase();
  const issuer = params.get("issuer");
  const credential: CxfCredential = {
    type: CXF_TYPES.totp,
    secret: params.get("secret") ?? "",
    period: Number.parseInt(params.get("period") ?? "30", 10) || 30,
    digits: Number.parseInt(params.get("digits") ?? "6", 10) || 6,
    algorithm:
      algorithm === "sha256" || algorithm === "sha512" ? algorithm : "sha1",
    username,
  };
  if (issuer !== null) credential.issuer = issuer;
  credential.extensions = [{ name: CXF_EXTENSION, otpauth: raw }];
  return credential;
}

function textFields(
  rows: readonly (readonly [string, string, boolean])[],
): CxfEditableField[] {
  return rows
    .filter(([, value]) => value !== "")
    .map(([label, value, hidden]) => ({
      fieldType: hidden ? ("concealed-string" as const) : ("string" as const),
      value,
      label,
    }));
}

function methodCredential(
  method: Exclude<LoginMethod, { type: "password" | "authenticator" }>,
): CxfCredential | null {
  switch (method.type) {
    case "api-key": {
      if (method.key === "") return null;
      const credential: CxfCredential = {
        type: CXF_TYPES.apiKey,
        key: field(method.key, "concealed-string"),
      };
      if (method.header !== "") {
        credential.extensions = [
          { name: CXF_EXTENSION, header: method.header },
        ];
      }
      return credential;
    }
    case "token": {
      const fields = textFields([
        ["Token", method.token, true],
        ["Expires", method.expiresAt, false],
      ]);
      return fields.length === 0
        ? null
        : {
            type: CXF_TYPES.customFields,
            id: method.id,
            label: "Token",
            fields,
          };
    }
    case "oauth": {
      const fields = textFields([
        ["Client ID", method.clientId, false],
        ["Client secret", method.clientSecret, true],
        ["Token URL", method.tokenUrl, false],
        ["Scopes", method.scopes, false],
        ["Refresh token", method.refreshToken, true],
      ]);
      return fields.length === 0
        ? null
        : {
            type: CXF_TYPES.customFields,
            id: method.id,
            label: "OAuth client",
            fields,
          };
    }
  }
}

export type AccountCredentials = {
  credentials: CxfCredential[];
  /** Password methods left out because they need a pepper. */
  withheld: number;
};

export function accountCredentials(item: AccountItem): AccountCredentials {
  return methodCredentials(item.methods, item.username, true);
}

/**
 * The CXF credentials for login methods. An account always carries a
 * `basic-auth` that names its username; a credential kept on its own (ADR 0179)
 * is only what it is.
 */
export function methodCredentials(
  methods: readonly LoginMethod[],
  username: string,
  asAccount: boolean,
): AccountCredentials {
  const credentials: CxfCredential[] = [];
  let withheld = 0;
  let hasBasic = false;
  for (const method of methods) {
    if (method.type === "password") {
      // A CXF credential holds a whole password, and a file never holds one an
      // algorithm computed (ADR 0174): CXF has no field for its parameters.
      // That, a password missing its pepper and one an older version made are
      // withheld, and counted.
      const produced = producePassword(method);
      if (isAlgorithmic(method) || produced.status === "legacy") {
        withheld += 1;
        continue;
      }
      const whole = completePassword(produced);
      if (whole === null && produced.status !== "absent") {
        withheld += 1;
        continue;
      }
      hasBasic = true;
      credentials.push({
        type: CXF_TYPES.basicAuth,
        username: field(username, "string"),
        // The facade's whole password: a stored one, or what a derived method
        // computes. Never the root it computes from.
        password: field(whole ?? "", "concealed-string"),
      });
    } else if (method.type === "authenticator") {
      const totp = totpCredential(method.secret, username);
      if (totp !== null) credentials.push(totp);
    } else {
      const credential = methodCredential(method);
      if (credential !== null) credentials.push(credential);
    }
  }
  if (asAccount && !hasBasic) {
    credentials.unshift({
      type: CXF_TYPES.basicAuth,
      username: field(username, "string"),
    });
  }
  return { credentials, withheld };
}
