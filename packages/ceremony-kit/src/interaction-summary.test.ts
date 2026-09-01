import type { InteractionDetail, InteractionKind } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { renderInteractionSummary } from "./index.js";

/** Right-to-left override: reverses the display order of everything after it. */
const RLO = "\u202E";
const LRE = "\u202A";
const RLE = "\u202B";
const LRI = "\u2066";
const PDI = "\u2069";
const RLM = "\u200F";
const ZWSP = "\u200B";

function detail(patch: Partial<InteractionDetail> = {}): InteractionDetail {
  return {
    id: "int_1",
    kind: "transaction_authorization",
    status: "awaiting_approval",
    requiresApprover: true,
    createdAt: new Date("2026-09-01T09:55:00.000Z"),
    expiresAt: new Date("2026-09-01T10:00:00.000Z"),
    authorizationDetails: [],
    ...patch,
  };
}

describe("renderInteractionSummary", () => {
  it("asks the question terse, in a fixed order", () => {
    expect(
      renderInteractionSummary(
        detail({
          bindingMessage: "Pay ACME Ltd 42.00 EUR",
          requesterRef: "req_9",
          resourceRef: "conn_7",
        }),
      ),
    ).toEqual({
      title: "Authorize this transaction",
      lines: [
        "Pay ACME Ltd 42.00 EUR",
        "From req_9",
        "Resource conn_7",
        "Expires 2026-09-01T10:00:00.000Z",
      ],
    });
  });

  it("names the ceremony, and never confuses a device with a claim", () => {
    const title = (kind: InteractionKind) =>
      renderInteractionSummary(detail({ kind })).title;
    expect(title("device_authorization")).toBe("Approve this device");
    expect(title("claim")).toBe("Accept this claim");
    expect(title("device_authorization")).not.toBe(title("claim"));
    expect(title("pairing")).toBe("Pair this device");
    expect(title("grant_claim")).toBe("Accept this grant");
    expect(title("authorization_request")).toBe("Approve this request");
    /* SAFETY: the client carries the server's kind vocabulary through
       unvalidated by contract, so a kind outside the union is exactly what a
       deployed build meets when a new ceremony ships — the assertion stages
       that, and the expectation is that it still reads as a decision, not a
       blank. */
    expect(title("wallet_handoff" as InteractionKind)).toBe(
      "Approve this request",
    );
  });

  it("adds an outcome line only once the answer is settled", () => {
    const line = (status: InteractionDetail["status"]) =>
      renderInteractionSummary(detail({ status })).lines.at(-1);
    expect(line("pending")).toBe("Expires 2026-09-01T10:00:00.000Z");
    expect(line("presented")).toBe("Expires 2026-09-01T10:00:00.000Z");
    expect(line("awaiting_approval")).toBe("Expires 2026-09-01T10:00:00.000Z");
    expect(line("approved")).toBe("Already approved");
    expect(line("denied")).toBe("Already denied");
    expect(line("consumed")).toBe("Already used");
    expect(line("expired")).toBe("Expired");
    expect(line("revoked")).toBe("Withdrawn");
  });

  it("strips a bidi override out of a payee name", () => {
    // A right-to-left override makes the glyphs the human reads differ from
    // the bytes that get approved — the spoof this sanitizer exists for.
    const rendered = renderInteractionSummary(
      detail({
        requesterRef: `ACME${RLO}dtl-yfp`,
        bindingMessage: `Pay ${LRI}ACME${RLO} Ltd${PDI} 42.00 EUR`,
        resourceRef: `conn${ZWSP}_7`,
      }),
    );
    const all = [rendered.title, ...rendered.lines].join("\n");
    for (const hostile of [RLO, LRE, RLE, LRI, PDI, RLM, ZWSP]) {
      expect(all).not.toContain(hostile);
    }
    expect(rendered.lines).toContain("From ACMEdtl-yfp");
    expect(rendered.lines).toContain("Resource conn_7");
  });

  it("strips control characters that would forge extra rows", () => {
    const rendered = renderInteractionSummary(
      detail({ requesterRef: "req_9\nFrom bank.example\r " }),
    );
    expect(rendered.lines).toContain("From req_9From bank.example");
    expect(rendered.lines.join("")).not.toContain("\n");
  });

  it("truncates a 10 KB resource name and marks it as cut", () => {
    const rendered = renderInteractionSummary(
      detail({ resourceRef: "R".repeat(10240) }),
    );
    const line = rendered.lines.find((entry) => entry.startsWith("Resource "));
    if (line === undefined) throw new Error("expected a resource line");
    expect(line.length).toBeLessThan(120);
    expect(line.endsWith("…")).toBe(true);
  });

  it("emits no output that could be read as markup", () => {
    const rendered = renderInteractionSummary(
      detail({
        requesterRef: "<img src=x onerror=alert(1)>",
        resourceRef: "</span><script>alert(1)</script>",
        bindingMessage: "<b>Pay</b> 42.00 EUR",
      }),
    );
    for (const value of [rendered.title, ...rendered.lines]) {
      expect(value).not.toContain("<");
      expect(value).not.toContain(">");
    }
  });

  it("omits a field rather than printing an empty row", () => {
    const rendered = renderInteractionSummary(
      detail({ requesterRef: `   ${ZWSP} `, bindingMessage: "" }),
    );
    expect(rendered.lines).toEqual(["Expires 2026-09-01T10:00:00.000Z"]);
  });
});
