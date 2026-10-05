import {
  type AccountItem,
  type LoginMethod,
  type PasswordMethod,
  type PepperSeal,
  type VaultBody,
  createItem,
  manualPassword,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { fidoCxf } from "../import/formats/cxf.js";
import { defaultMergeOptions, planMerge } from "../import/merge.js";
import type { DraftAccount } from "../import/types.js";
import { CXF_TYPES, buildCxfExport, serializeCxfExport } from "./cxf.js";

const NOW = "2026-03-04T05:06:07.000Z";
const SEED = "JBSWY3DPEHPK3PXP";

function account(methods: LoginMethod[], username = "ada"): AccountItem {
  const item = createItem("account", "Service");
  item.username = username;
  item.uris = [{ id: "u1", uri: "https://service.example", match: "domain" }];
  item.methods = methods;
  item.createdAt = NOW;
  item.updatedAt = NOW;
  return item;
}

function body(...items: AccountItem[]): VaultBody {
  return { v: 1, items, folders: [] };
}

function exportOf(vault: VaultBody) {
  return buildCxfExport(vault, {
    humanConfirmed: true,
    exportedAt: new Date(NOW),
  });
}

function reimport(vault: VaultBody): DraftAccount[] {
  const text = serializeCxfExport(exportOf(vault).document);
  const result = fidoCxf.parse({
    fileName: "export.json",
    text,
    headers: null,
    json: JSON.parse(text),
    bytes: null,
  });
  return result.items.filter(
    (item): item is DraftAccount => item.kind === "account",
  );
}

/** The vault item an account draft becomes, for comparing modulo ids. */
function landed(draft: DraftAccount): AccountItem {
  const item = planMerge([draft], [], [], defaultMergeOptions).items[0];
  if (item?.kind !== "account") throw new Error("expected an account");
  return item;
}

/** Everything about an account except what the merge mints fresh. */
function comparable(item: AccountItem) {
  return {
    username: item.username,
    uris: item.uris.map((uri) => uri.uri),
    methods: item.methods.map((method) => {
      const { id: _id, ...rest } = method;
      return "changedAt" in rest ? { ...rest, changedAt: "<time>" } : rest;
    }),
  };
}

describe("exporting an account's login methods", () => {
  it("round-trips several methods into an equal account", () => {
    const original = account([
      manualPassword("a:p1", "first-password", NOW),
      { id: "a:t1", type: "authenticator", secret: SEED },
      manualPassword("a:p2", "second-password", NOW),
      { id: "a:t2", type: "authenticator", secret: "KRSXG5CTMVRXEZLU" },
      { id: "a:k1", type: "api-key", key: "key-123", header: "X-Api-Key" },
    ]);
    const [draft] = reimport(body(original));
    if (draft === undefined) throw new Error("no account came back");
    // An import reads the first password and the first seed into the draft's
    // own slots and the rest after them, so the original is in that order.
    expect(comparable(landed(draft))).toEqual(comparable(original));
  });

  it("writes a basic-auth per password, a totp per seed and an api-key", () => {
    const original = account([
      manualPassword("a:p1", "first-password", NOW),
      { id: "a:t1", type: "authenticator", secret: SEED },
      { id: "a:k1", type: "api-key", key: "key-123", header: "X-Api-Key" },
    ]);
    const types = exportOf(
      body(original),
    ).document.accounts[0]?.items[0]?.credentials.map((c) => c.type);
    expect(types).toEqual([
      CXF_TYPES.basicAuth,
      CXF_TYPES.totp,
      CXF_TYPES.apiKey,
    ]);
  });

  it("writes a token and an OAuth client as custom fields", () => {
    const original = account([
      manualPassword("a:p1", "pw", NOW),
      { id: "a:tok", type: "token", token: "tok-1", expiresAt: NOW },
      {
        id: "a:oa",
        type: "oauth",
        clientId: "client-1",
        clientSecret: "client-secret",
        tokenUrl: "https://service.example/token",
        scopes: "read write",
        refreshToken: "refresh-1",
      },
    ]);
    const credentials =
      exportOf(body(original)).document.accounts[0]?.items[0]?.credentials ??
      [];
    const custom = credentials.filter((c) => c.type === CXF_TYPES.customFields);
    expect(custom).toHaveLength(2);
    const token = custom[0];
    if (token?.type !== CXF_TYPES.customFields) throw new Error("no token");
    expect(token.fields).toEqual([
      { fieldType: "concealed-string", value: "tok-1", label: "Token" },
      { fieldType: "string", value: NOW, label: "Expires" },
    ]);
    const oauth = custom[1];
    if (oauth?.type !== CXF_TYPES.customFields) throw new Error("no oauth");
    expect(oauth.fields.map((f) => [f.label, f.fieldType] as const)).toEqual([
      ["Client ID", "string"],
      ["Client secret", "concealed-string"],
      ["Token URL", "string"],
      ["Scopes", "string"],
      ["Refresh token", "concealed-string"],
    ]);
  });

  it("round-trips a seed-only account without inventing a password", () => {
    const original = account([
      { id: "a:t1", type: "authenticator", secret: SEED },
    ]);
    const [draft] = reimport(body(original));
    if (draft === undefined) throw new Error("no account came back");
    expect(draft.password).toBe("");
    expect(draft.totp).toBe(SEED);
    expect(comparable(landed(draft))).toEqual(comparable(original));
  });
});

describe("a password that needs a pepper is withheld", () => {
  const sealed: PepperSeal = {
    v: 1,
    kdf: { alg: "PBKDF2-SHA256", saltB64: "c2FsdA==", iterations: 1 },
    seal: { ivB64: "aXY=", ctB64: "Y3Q=" },
  };

  function peppered(): PasswordMethod {
    return {
      id: "a:p1",
      type: "password",
      generator: { id: "manual" },
      pepper: true,
      secret: "",
      sealed,
      changedAt: NOW,
    };
  }

  function sphinx(): PasswordMethod {
    return {
      id: "a:p2",
      type: "password",
      generator: {
        id: "sphinx",
        rules: {
          length: 20,
          lower: true,
          upper: true,
          digits: true,
          symbols: true,
          avoidAmbiguous: false,
          minDigits: 0,
          minSymbols: 0,
        },
        realm: "service.example",
        counter: 0,
        oprfKeyB64: "T1BSRi1LRVktRElELU5PVC1FWFBPUlQ=",
      },
      pepper: true,
      secret: "",
      changedAt: NOW,
    };
  }

  it("counts peppered and Sphinx passwords and writes neither", () => {
    const vault = body(
      account([
        peppered(),
        { id: "a:t1", type: "authenticator", secret: SEED },
      ]),
      account([sphinx(), manualPassword("b:p", "plain", NOW)], "bob"),
    );
    const result = exportOf(vault);
    expect(result.withheld).toBe(2);
    const text = serializeCxfExport(result.document);
    expect(text).not.toContain("c2FsdA==");
    expect(text).not.toContain("Y3Q=");
    expect(text).not.toContain("T1BSRi1LRVktRElELU5PVC1FWFBPUlQ=");
    expect(text).not.toContain("oprfKeyB64");
    expect(text).not.toContain("sealed");
    expect(text).toContain("plain");
  });

  it("still writes the username, so the account arrives as an account", () => {
    const vault = body(account([peppered()]));
    const result = exportOf(vault);
    const basic = result.document.accounts[0]?.items[0]?.credentials[0];
    if (basic?.type !== CXF_TYPES.basicAuth) throw new Error("no basic-auth");
    expect(basic.username?.value).toBe("ada");
    expect(basic.password).toBeUndefined();
    const [draft] = reimport(vault);
    expect(draft?.username).toBe("ada");
    expect(draft?.password).toBe("");
  });

  it("reports zero when nothing was withheld", () => {
    const vault = body(account([manualPassword("a:p", "pw", NOW)]));
    expect(exportOf(vault).withheld).toBe(0);
  });
});
