import { FORBIDDEN_URL_PARAMS } from "@opensesame/os-domain";
import type {
  BoundaryValue,
  MutableBoundaryObject,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { WalletPayloadRejected, assertPassPayloadSafe } from "./payload.js";

/** A pass that a real interaction would produce. Nothing here is a bearer. */
const CLEAN_PASS = {
  id: "3388000000022125777.7cVQeR0m9v0S9WcCQ1r4XmB2v0aPq8Lz",
  classId: "3388000000022125777.interaction",
  state: "ACTIVE",
  cardTitle: { defaultValue: { language: "en-US", value: "Device approval" } },
  header: { defaultValue: { language: "en-US", value: "Approve terminal" } },
  barcode: {
    type: "QR_CODE",
    value: "https://interactions.example.test/i/i_aW50X2Fic3RyYWN0.9Xq2",
  },
  textModulesData: [{ id: "row_0", header: "Device", body: "workstation-14" }],
  linksModuleData: {
    uris: [
      {
        id: "interaction",
        uri: "https://interactions.example.test/i/i_aW50X2Fic3RyYWN0.9Xq2",
        description: "Open this request",
      },
    ],
  },
  validTimeInterval: {
    start: { date: "2026-08-31T12:00:00.000Z" },
    end: { date: "2026-08-31T12:10:00.000Z" },
  },
  hexBackgroundColor: "#1f2933",
};

/**
 * A nineteen-digit Google issuer id that is *also* a valid Visa-19.
 *
 * It begins with `4`, is nineteen digits, and passes Luhn, so the prefix table
 * cannot tell it from a card. Every issuer id used elsewhere in this suite
 * fails Luhn and therefore proves nothing about the rule that protects them.
 */
const LUHN_VALID_ISSUER_ID = "4388000000022125772";

/**
 * Luhn-valid cards from the networks a Visa/Mastercard/Amex table misses.
 *
 * All are structurally valid and none is issued: the account digits are zeroes
 * behind a real issuer-identification prefix.
 */
const UNCOVERED_NETWORK_PANS: ReadonlyArray<readonly [string, string]> = [
  ["Maestro", "6759000000000000"],
  ["Maestro, nineteen digits", "6759000000000000005"],
  ["Diners Club, sixteen digits", "3050000000000003"],
  ["Mastercard, nineteen digits", "5510000000000000003"],
  ["Elo", "5067000000000009"],
  ["Hipercard", "6062000000000002"],
  ["Dankort", "5019000000000008"],
  ["Mir", "2200000000000004"],
  ["UATP", "100000000000009"],
];

function rejection(payload: BoundaryValue): WalletPayloadRejected {
  try {
    assertPassPayloadSafe(payload);
  } catch (error) {
    if (error instanceof WalletPayloadRejected) return error;
    throw error;
  }
  throw new Error("expected the payload to be rejected");
}

describe("assertPassPayloadSafe — a legitimate pass", () => {
  it("passes a full Google Generic object unchanged", () => {
    expect(() => assertPassPayloadSafe(CLEAN_PASS)).not.toThrow();
  });

  it("passes the primitives a pass is made of", () => {
    expect(() => assertPassPayloadSafe(null)).not.toThrow();
    expect(() => assertPassPayloadSafe("Approve this login")).not.toThrow();
    expect(() => assertPassPayloadSafe(1767225600)).not.toThrow();
    expect(() => assertPassPayloadSafe([])).not.toThrow();
  });

  it("does not mistake a nineteen-digit Google issuer id for a card", () => {
    // The regression this guards: a bare Luhn test flags roughly one issuer id
    // in ten, and the issuer id is in every single pass we build.
    for (const issuerId of [
      "3388000000022125777",
      "3388000000022125785",
      "4388000000022125777",
    ]) {
      expect(() =>
        assertPassPayloadSafe({ classId: `${issuerId}.interaction` }),
      ).not.toThrow();
    }
  });

  it("does not mistake an ISO timestamp for a card number", () => {
    expect(() =>
      assertPassPayloadSafe({ date: "2026-08-31T12:00:00.000Z" }),
    ).not.toThrow();
  });
});

describe("assertPassPayloadSafe — forbidden field names", () => {
  it("refuses every name on the shared deny-list", () => {
    for (const name of FORBIDDEN_URL_PARAMS) {
      const error = rejection({ [name]: "anything at all" });
      expect(error).toBeInstanceOf(WalletPayloadRejected);
      expect(["forbidden_key", "card_verification_value"]).toContain(
        error.rule,
      );
    }
  });

  it("refuses the camelCase, kebab, and shouted spellings alike", () => {
    for (const name of [
      "accessToken",
      "Access-Token",
      "ACCESS_TOKEN",
      "access token",
    ]) {
      expect(rejection({ [name]: "x" }).rule).toBe("forbidden_key");
    }
  });

  it("names card verification values as such", () => {
    expect(rejection({ cvc2: "123" }).rule).toBe("card_verification_value");
    expect(rejection({ cardSecurityCode: "123" }).rule).toBe(
      "card_verification_value",
    );
  });

  it("reaches names nested anywhere in the object", () => {
    const error = rejection({
      textModulesData: [{ id: "row_0", header: "Login", body: { token: "x" } }],
    });
    expect(error.rule).toBe("forbidden_key");
    expect(error.path).toBe("$.textModulesData[0].body.token");
  });

  it("does not confuse `barcode` with the forbidden name `code`", () => {
    expect(() =>
      assertPassPayloadSafe({ barcode: { type: "QR_CODE", value: "x" } }),
    ).not.toThrow();
  });
});

describe("assertPassPayloadSafe — forbidden URL parameters", () => {
  it("refuses a bearer smuggled in a query string", () => {
    const error = rejection({
      uri: "https://interactions.example.test/i/abc?token=s3cr3t",
    });
    expect(error.rule).toBe("forbidden_url_param");
  });

  it("refuses a bearer smuggled in a fragment", () => {
    // The fragment never reaches a server, which is exactly why a link builder
    // reaches for it — and a wallet pass is read entirely client-side.
    const error = rejection({
      uri: "https://interactions.example.test/i/abc#access_token=s3cr3t",
    });
    expect(error.rule).toBe("forbidden_url_param");
  });

  it("refuses a script-bearing scheme in a tappable link", () => {
    expect(rejection({ uri: "javascript:alert(1)" }).rule).toBe(
      "unsafe_url_scheme",
    );
    expect(rejection({ uri: "data:text/html,<b>x</b>" }).rule).toBe(
      "unsafe_url_scheme",
    );
  });

  it("leaves an ordinary interaction URL alone", () => {
    expect(() =>
      assertPassPayloadSafe({
        uri: "https://interactions.example.test/i/i_aW50Xw.9Xq2?lang=en",
      }),
    ).not.toThrow();
  });
});

describe("assertPassPayloadSafe — bearer shapes", () => {
  it("refuses an OpenSesame claim token", () => {
    expect(rejection({ body: "osc_clm_1f3a9c2b.4d5e" }).rule).toBe(
      "bearer_shape",
    );
  });

  it("refuses a JWT", () => {
    const jwt =
      "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl";
    expect(rejection({ header: `session ${jwt}` }).rule).toBe("bearer_shape");
  });

  it("refuses a pasted Authorization header", () => {
    expect(rejection({ body: "Bearer ya29.a0AfB_byC9x1QzP" }).rule).toBe(
      "bearer_shape",
    );
  });

  it("refuses a PEM block", () => {
    expect(rejection({ body: "-----BEGIN PRIVATE KEY-----\nMIIE" }).rule).toBe(
      "bearer_shape",
    );
  });
});

describe("assertPassPayloadSafe — card data", () => {
  it("refuses a PAN, spaced as a human would type it", () => {
    expect(rejection({ body: "4111 1111 1111 1111" }).rule).toBe(
      "primary_account_number",
    );
  });

  it("refuses a PAN embedded in a sentence", () => {
    expect(rejection({ body: "charged to 5555555555554444 today" }).rule).toBe(
      "primary_account_number",
    );
  });

  it("refuses an Amex, which is neither 16 digits nor Visa-prefixed", () => {
    expect(rejection({ body: "378282246310005" }).rule).toBe(
      "primary_account_number",
    );
  });

  it("accepts a long digit run that is not a card", () => {
    expect(() =>
      assertPassPayloadSafe({ body: "order 900000000000001" }),
    ).not.toThrow();
  });
});

describe("assertPassPayloadSafe — labelled opaque runs", () => {
  it("refuses a near-miss field name holding an opaque run", () => {
    // `userToken` is not on the deny-list, but its words say what it holds.
    const error = rejection({ userToken: "M2Y0YTk4YmMxZDdlNGYyMA" });
    expect(error.rule).toBe("labelled_high_entropy");
  });

  it("leaves a labelled short value alone", () => {
    expect(() =>
      assertPassPayloadSafe({ userCode: "WDJB-MJHT" }),
    ).not.toThrow();
  });

  it("leaves an unlabelled opaque run alone", () => {
    // The barcode value is a long opaque reference, and it is meant to be.
    expect(() =>
      assertPassPayloadSafe({ value: "i_aW50XzEyMzQ1Njc4OTA.9Xq2Kf0Lm3" }),
    ).not.toThrow();
  });
});

describe("assertPassPayloadSafe — the walk itself", () => {
  it("refuses a self-referential payload rather than looping forever", () => {
    const cyclic: MutableBoundaryObject = { header: "Approve" };
    cyclic.self = cyclic;
    expect(rejection(cyclic).rule).toBe("cyclic_payload");
  });

  it("never quotes the value it rejected", () => {
    const error = rejection({ accessToken: "super-secret-value-12345" });
    expect(error.message).not.toContain("super-secret-value-12345");
    expect(error.message).toContain("accessToken");
    expect(error.path).toBe("$.accessToken");
  });

  it("reports a path an operator can navigate to", () => {
    const error = rejection({
      payload: { genericObjects: [{ linksModuleData: { password: "x" } }] },
    });
    expect(error.path).toBe(
      "$.payload.genericObjects[0].linksModuleData.password",
    );
  });
});

describe("assertPassPayloadSafe — a value wrapped in an array", () => {
  // Brackets are not a change of meaning. `{ secretData: "…" }` was refused and
  // `{ secretData: ["…"] }` was issued, because array children were walked with
  // no name at all and every field-name rule needs one.
  const OPAQUE = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA";

  it("refuses a labelled opaque run that is wrapped in an array", () => {
    const error = rejection({ secretData: [OPAQUE] });
    expect(error.rule).toBe("labelled_high_entropy");
    expect(error.path).toBe("$.secretData[0]");
  });

  it("follows the owning name through however many arrays it is nested in", () => {
    const error = rejection({ secretData: [[[OPAQUE]]] });
    expect(error.rule).toBe("labelled_high_entropy");
    expect(error.path).toBe("$.secretData[0][0][0]");
  });

  it("refuses a forbidden name whose value is an array of objects", () => {
    expect(rejection({ rows: [{ accessToken: OPAQUE }] }).rule).toBe(
      "forbidden_key",
    );
  });

  it("still leaves an array of unlabelled opaque references alone", () => {
    // The regression risk of inheriting a name: an array named for something
    // innocuous must not start refusing the opaque references a pass carries.
    expect(() =>
      assertPassPayloadSafe({
        origins: ["https://interactions.example.test"],
        textModulesData: [
          { id: "row_0", header: "Device", body: "i_aW50XzEyMzQ1Njc4OTA.9Xq2" },
        ],
      }),
    ).not.toThrow();
  });
});

describe("assertPassPayloadSafe — what is scanned is what is emitted", () => {
  it("refuses a value that decides its own serialized form", () => {
    // Walking the live graph saw `{ toJSON: <function> }` — an object with no
    // entries worth inspecting — and `JSON.stringify` then emitted the token.
    const error = rejection({
      note: { toJSON: () => "osc_clm_AAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    });
    expect(error.rule).toBe("non_json_value");
  });

  it("refuses an accessor, which answers rather than holds", () => {
    // The same substitution without `toJSON`: show the check something dull,
    // show the signer the credential. Scanning the emitted bytes closes the gap
    // between the walk and the serialization; refusing accessors outright
    // closes the one between this gate's serialization and the signer's.
    let reads = 0;
    const payload = {
      get body(): string {
        reads += 1;
        return reads === 1
          ? "workstation-14"
          : "osc_clm_AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      },
    };
    const error = rejection(payload);
    expect(error.rule).toBe("non_json_value");
    expect(error.path).toBe("$.body");
    // Refused without ever asking: a value that was never a question cannot be
    // answered twice.
    expect(reads).toBe(0);
  });

  it("refuses the containers JSON.stringify would quietly empty", () => {
    // Each of these serializes to `{}`: everything the caller put in them is
    // dropped without a word, so a pass would ship missing its content.
    const containers: ReadonlyArray<BoundaryValue> = [
      new Map<PropertyKey, BoundaryValue>([["header", "Approve"]]),
      new Set<BoundaryValue>(["Approve"]),
      new Uint8Array([4, 1, 1, 1]),
      new Date("2026-08-31T12:00:00.000Z"),
    ];
    for (const container of containers) {
      expect(rejection({ detail: container }).rule).toBe("non_json_value");
    }
  });

  it("refuses a bigint rather than throwing out of the gate", () => {
    // `JSON.stringify` throws a bare TypeError on a bigint. A mandatory gate
    // that crashes reads as broken code rather than as a refusal.
    expect(rejection({ amount: 4111111111111111n }).rule).toBe(
      "non_json_value",
    );
  });
});

describe("assertPassPayloadSafe — sharing is not a cycle", () => {
  it("passes a payload that uses one object in two places", () => {
    // `seen` was never popped, so the second sighting of a shared node was
    // reported as a loop — a mandatory gate that would have hard-failed the
    // first time a caller built two rows from one record.
    const shared = { defaultValue: { language: "en-US", value: "Approve" } };
    expect(() =>
      assertPassPayloadSafe({ header: shared, cardTitle: shared }),
    ).not.toThrow();
  });

  it("passes a payload that uses one array in two places", () => {
    const shared = ["https://interactions.example.test"];
    expect(() =>
      assertPassPayloadSafe({ origins: shared, alsoOrigins: shared }),
    ).not.toThrow();
  });

  it("still refuses a real cycle", () => {
    const cyclic: MutableBoundaryObject = { header: "Approve" };
    cyclic.self = cyclic;
    expect(rejection(cyclic).rule).toBe("cyclic_payload");
  });
});

describe("assertPassPayloadSafe — card numbers beside a dot", () => {
  // The skip that keeps Google resource ids out of this rule used to fire on
  // any digit run with a dot on either side, which is most of the ways a card
  // number appears in a sentence.
  it("refuses a card number that ends a sentence", () => {
    expect(rejection({ body: "Charged to 4111111111111111." }).rule).toBe(
      "primary_account_number",
    );
  });

  it("refuses a card number followed by a decimal amount", () => {
    expect(rejection({ body: "4111111111111111.00" }).rule).toBe(
      "primary_account_number",
    );
  });

  it("refuses a card number hidden behind a version-shaped prefix", () => {
    expect(rejection({ body: "v1.4111111111111111" }).rule).toBe(
      "primary_account_number",
    );
  });

  it("refuses a card number written with dots between its groups", () => {
    // No run of twelve consecutive digits exists in this string at all.
    expect(rejection({ body: "4111.1111.1111.1111" }).rule).toBe(
      "primary_account_number",
    );
  });

  it("leaves a Luhn-valid nineteen-digit issuer id in a resource id alone", () => {
    // This issuer id begins with `4`, is nineteen digits, and passes Luhn: it
    // is a Visa-19 as far as the prefix table is concerned. What saves it is
    // being written in the dotted shape every Google resource id has.
    expect(() =>
      assertPassPayloadSafe({
        classId: `${LUHN_VALID_ISSUER_ID}.interaction`,
        id: `${LUHN_VALID_ISSUER_ID}.7cVQeR0m9v0S9WcCQ1r4XmB2v0aPq8Lz`,
      }),
    ).not.toThrow();
  });

  it("refuses the same digits when nothing makes them an identifier", () => {
    // The honest other half of the trade-off above, stated so a future reader
    // knows it is deliberate rather than an accident of the regex.
    expect(rejection({ issuer: LUHN_VALID_ISSUER_ID }).rule).toBe(
      "primary_account_number",
    );
  });
});

describe("assertPassPayloadSafe — card networks beyond the big four", () => {
  it("refuses a card from every network in the table", () => {
    for (const [network, pan] of UNCOVERED_NETWORK_PANS) {
      const error = rejection({ body: `paid with ${pan}` });
      expect(`${network}: ${error.rule}`).toBe(
        `${network}: primary_account_number`,
      );
    }
  });

  it("refuses a card number typed in full-width digits", () => {
    // `\d` under `/u` is ASCII-only. A card number typed on an IME is still a
    // card number to the human reading it off a lock screen.
    expect(rejection({ body: "４１１１１１１１１１１１１１１１" }).rule).toBe(
      "primary_account_number",
    );
  });

  it("refuses a card number typed in Arabic-Indic digits", () => {
    expect(rejection({ body: "٤١١١١١١١١١١١١١١١" }).rule).toBe(
      "primary_account_number",
    );
  });

  it("still leaves ordinary numbers of card-like length alone", () => {
    for (const value of [
      "order 900000000000001",
      "2026-08-31T12:00:00.000Z",
      "192.168.100.101",
      "v1.2.3",
      "+1 555 0100",
    ]) {
      expect(() => assertPassPayloadSafe({ body: value })).not.toThrow();
    }
  });
});

describe("assertPassPayloadSafe — the card rule's measured precision", () => {
  /**
   * A seeded generator, so the rates below are a fact about the rule rather
   * than a coin toss that fails one CI run in twenty.
   */
  function samples(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function digitString(
    next: () => number,
    length: number,
    first: string,
  ): string {
    let out = first;
    while (out.length < length) out += String(Math.floor(next() * 10));
    return out;
  }

  const SAMPLE_COUNT = 5000;

  function flaggedRate(make: (next: () => number) => string): number {
    const next = samples(20260831);
    let flagged = 0;
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      try {
        assertPassPayloadSafe({ body: make(next) });
      } catch (error) {
        if (!(error instanceof WalletPayloadRejected)) throw error;
        if (error.rule === "primary_account_number") flagged += 1;
      }
    }
    return flagged / SAMPLE_COUNT;
  }

  it("flags one in ten nineteen-digit strings that begin with 4", () => {
    // The number the header comment cites: for the Visa branch the prefix test
    // buys nothing at all, and saying so is the point of measuring.
    const rate = flaggedRate((next) => digitString(next, 19, "4"));
    expect(rate).toBeGreaterThan(0.09);
    expect(rate).toBeLessThan(0.11);
  });

  it("flags about one in forty arbitrary nineteen-digit strings", () => {
    // 1.2% before the network table grew, 2.6% after. Both are documented; a
    // future entry that pushed this materially higher should have to argue.
    const rate = flaggedRate((next) => digitString(next, 19, ""));
    expect(rate).toBeGreaterThan(0.02);
    expect(rate).toBeLessThan(0.032);
  });

  it("flags no Google resource id at all, whatever the issuer id is", () => {
    // The rate that decides whether this gate can stay switched on. It is zero
    // because of the dotted-identifier shape, not because of the prefix table.
    const rate = flaggedRate(
      (next) => `${digitString(next, 19, "4")}.interaction`,
    );
    expect(rate).toBe(0);
  });
});

describe("assertPassPayloadSafe — the refusal is safe to log", () => {
  const JWT =
    "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2ln";

  it("elides a field name carrying a newline", () => {
    // A display row label becomes a field name (see `google.ts`), and a label
    // is free-form UI text. Interpolated raw, it forges a second log line.
    const error = rejection({
      "Note\nwallet payload rejected [ok] at $: ok": JWT,
    });
    expect(error.message).not.toContain("\n");
    expect(error.path).not.toContain("\n");
    expect(error.path).toBe("$.<elided>");
  });

  it("elides a field name that is really a secret", () => {
    const secret = "M2Y0YTk4YmMxZDdlNGYyMA";
    const error = rejection({ [secret]: JWT });
    expect(error.message).not.toContain(secret);
    expect(error.path).not.toContain(secret);
  });

  it("elides a name too long to be one", () => {
    const error = rejection({ [`Detail ${"x".repeat(80)}`]: JWT });
    expect(error.message).not.toContain("xxxx");
  });

  it("still prints the names an operator has to navigate by", () => {
    // The elision must not swallow the ordinary case: a rejection nobody can
    // locate is a rejection somebody works around.
    expect(rejection({ accessToken: "x" }).message).toContain("accessToken");
    expect(rejection({ cardSecurityCode: "123" }).message).toContain(
      "cardSecurityCode",
    );
    expect(rejection({ "Access-Token": "x" }).path).toBe("$.Access-Token");
    expect(rejection({ payload: { rows: [{ password: "x" }] } }).path).toBe(
      "$.payload.rows[0].password",
    );
  });
});
