/**
 * Breach and two-step checks: what leaves the browser is five hex
 * characters of a hash and a request for a public list, and what comes back
 * is matched here.
 */
import {
  type AccountItem,
  createItem,
  manualPassword,
  newUri,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { breachWatchSnapshot } from "./health.js";
import {
  type CheckFetch,
  PWNED_RANGE_URL,
  TWO_FACTOR_LIST_URL,
  breachCounts,
  clearSecurityWatch,
  noteSecurityWatch,
  parseRange,
  parseTwoFactorList,
  reconcileSecurityWatchWithVault,
  runSecurityChecks,
  securityWatchLabel,
} from "./security-checks.js";

/** SHA-1 of "password", the corpus's most famous entry. */
const PASSWORD_SHA1 = "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8";

type Sent = { url: string; headers: Headers };
/** Full SHA-1 → how many breaches the corpus holds it in. */
type Corpus = ReadonlyMap<string, number>;
type RangeServer = { fetch: CheckFetch; sent: Sent[] };
type ListServer = { fetch: CheckFetch; requests: string[] };

function rangeServer(counts: Corpus): RangeServer {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (url, init) => {
      sent.push({ url, headers: new Headers(init.headers) });
      const prefix = url.slice(PWNED_RANGE_URL.length);
      const lines = [...counts]
        .filter(([hash]) => hash.startsWith(prefix))
        .map(([hash, count]) => `${hash.slice(5)}:${count}`);
      // Padding rows, as the real API sends with Add-Padding.
      lines.push("0000000000000000000000000000000000A:0");
      return new Response(lines.join("\r\n"));
    },
  };
}

const LIST = [
  ["GitHub", { domain: "github.com", tfa: ["totp"] }],
  [
    "Google",
    {
      domain: "google.com",
      "additional-domains": ["youtube.com"],
      tfa: ["totp"],
    },
  ],
  ["Broken", "not an object"],
];

function listServer(): ListServer {
  const requests: string[] = [];
  return {
    requests,
    fetch: async (url) => {
      requests.push(url);
      return Response.json(LIST);
    },
  };
}

function login(
  name: string,
  password: string,
  uri: string,
  totp = "",
): AccountItem {
  const base = createItem("account", name);
  if (base.kind !== "account") throw new Error("not an account");
  return {
    ...base,
    uris: [newUri(uri)],
    methods: [
      manualPassword(`${base.id}:password`, password, base.createdAt),
      ...(totp
        ? [
            {
              id: `${base.id}:authenticator`,
              type: "authenticator" as const,
              secret: totp,
            },
          ]
        : []),
    ],
  };
}

describe("the breach check", () => {
  it("sends only a five-character prefix, padded, and reads the count", async () => {
    const server = rangeServer(new Map([[PASSWORD_SHA1, 9_545_824]]));
    const counts = await breachCounts(["password", "password"], server.fetch);
    expect(counts.get("password")).toBe(9_545_824);
    expect(server.sent).toHaveLength(1);
    expect(server.sent[0]?.url).toBe(`${PWNED_RANGE_URL}5BAA6`);
    expect(server.sent[0]?.headers.get("add-padding")).toBe("true");
  });

  it("counts a password the corpus does not hold as zero", async () => {
    const server = rangeServer(new Map());
    const counts = await breachCounts(
      ["a-long-unique-passphrase"],
      server.fetch,
    );
    expect(counts.get("a-long-unique-passphrase")).toBe(0);
  });

  it("ignores padding rows and malformed lines", () => {
    expect(parseRange("ABC:3\r\nDEF:0\r\nnot a line\r\n:5")).toEqual(
      new Map([["ABC", 3]]),
    );
  });

  it("says when the service refused", async () => {
    await expect(
      breachCounts(["x"], async () => new Response(null, { status: 429 })),
    ).rejects.toThrow("The breach check failed (429).");
  });
});

describe("the two-step list", () => {
  it("reads every domain and additional domain, and skips what it cannot read", () => {
    expect(parseTwoFactorList(LIST)).toEqual(
      new Set(["github.com", "google.com", "youtube.com"]),
    );
    expect(parseTwoFactorList({ not: "a list" })).toEqual(new Set());
  });
});

describe("runSecurityChecks", () => {
  it("finds breached passwords and sites that take a code none is stored for", async () => {
    const range = rangeServer(new Map([[PASSWORD_SHA1, 12]]));
    const list = listServer();
    const items = [
      login("GitHub", "password", "https://github.com/login"),
      login("Mail", "unique-and-long-1", "https://accounts.google.com"),
      login(
        "Coded",
        "unique-and-long-2",
        "https://github.com",
        "JBSWY3DPEHPK3PXP",
      ),
      login("Plain", "unique-and-long-3", "https://example.org"),
      { ...login("Gone", "password", "https://github.com"), deletedAt: "x" },
    ];
    const report = await runSecurityChecks(
      items,
      range.fetch,
      list.fetch,
      () => new Date("2026-10-05T00:00:00.000Z"),
    );
    expect(report.checked).toBe(4);
    expect(report.checkedAt).toBe("2026-10-05T00:00:00.000Z");
    expect(
      report.findings.map((f) => [
        f.item.name,
        f.breaches,
        f.twoFactorAvailable,
      ]),
    ).toEqual([
      ["GitHub", 12, true],
      ["Mail", 0, true],
    ]);
    expect(list.requests).toEqual([TWO_FACTOR_LIST_URL]);
  });

  it("never fetches the list when every login stores a code", async () => {
    const list = listServer();
    const report = await runSecurityChecks(
      [login("A", "unique-and-long", "https://github.com", "JBSWY3DPEHPK3PXP")],
      rangeServer(new Map()).fetch,
      list.fetch,
    );
    expect(report.findings).toEqual([]);
    expect(list.requests).toEqual([]);
  });

  it("publishes a standing a person can read when the capability is on", async () => {
    clearSecurityWatch();
    expect(breachWatchSnapshot().phase).toBe("off");
    noteSecurityWatch({ phase: "idle" });
    expect(breachWatchSnapshot()).toMatchObject({
      phase: "idle",
      label: "Breach and two-step checks on. Not checked.",
    });
    const range = rangeServer(new Map([[PASSWORD_SHA1, 12]]));
    const list = listServer();
    const items = [
      login("GitHub", "password", "https://github.com/login"),
      login("Mail", "unique-and-long-1", "https://accounts.google.com"),
    ];
    const report = await runSecurityChecks(items, range.fetch, list.fetch);
    expect(securityWatchLabel(report)).toBe(
      "1 of 2 passwords found in known breaches. 2 logins could add an authenticator code.",
    );
    noteSecurityWatch({ phase: "checked", report });
    const watch = breachWatchSnapshot();
    expect(watch.phase).toBe("checked");
    if (watch.phase !== "checked") return;
    expect(watch.label).toBe(securityWatchLabel(report));
    expect(watch.breached).toBe(1);
    expect(watch.twoStep).toBe(2);
    expect(watch.lines.map((line) => line.name)).toEqual(["GitHub", "Mail"]);
    expect(watch.lines[0]?.sentences).toEqual([
      "Found in breaches 12 times: change this password",
      "This site takes an authenticator code; none is stored",
    ]);
    expect(watch.lines[1]?.sentences).toEqual([
      "This site takes an authenticator code; none is stored",
    ]);
    reconcileSecurityWatchWithVault(items);
    expect(breachWatchSnapshot().phase).toBe("checked");
    const edited = [
      ...items,
      login("Added", "another-unique-pass", "https://added.example"),
    ];
    reconcileSecurityWatchWithVault(edited);
    expect(breachWatchSnapshot()).toMatchObject({
      phase: "idle",
      label: "Breach and two-step checks on. Not checked.",
    });
    clearSecurityWatch();
    expect(breachWatchSnapshot().phase).toBe("off");
  });
});
