import { describe, expect, it } from "vitest";

import {
  MAX_BINDING_MESSAGE_CHARS,
  type MarkupDialect,
  renderNotification,
  sanitizeUntrustedText,
} from "../templates.js";
import { renderInput } from "./helpers.js";

const DIALECTS: MarkupDialect[] = [
  "plain",
  "slack_mrkdwn",
  "telegram_html",
  "teams_markdown",
  "xml_text",
];

/** The embedding, override and isolate controls, spelled out. */
const BIDI_CONTROL_CHARACTERS = [
  "\u{202A}",
  "\u{202B}",
  "\u{202C}",
  "\u{202D}",
  "\u{202E}",
  "\u{2066}",
  "\u{2067}",
  "\u{2068}",
  "\u{2069}",
];

describe("sanitizeUntrustedText", () => {
  it("removes bidi overrides used to reverse what an approver reads", () => {
    // The Trojan Source shape: an override plus reversed text renders as a
    // sentence the bytes do not contain.
    const spoofed = "Approve \u{202E}tnuocca ym niard\u{202C} now";
    const clean = sanitizeUntrustedText(spoofed, {
      dialect: "plain",
      maxLength: 200,
    });
    for (const control of BIDI_CONTROL_CHARACTERS) {
      expect(clean).not.toContain(control);
    }
    expect(clean).toContain("Approve");
  });

  it("removes every bidi and invisible code point it claims to", () => {
    const hostile = [
      "\u{202A}",
      "\u{202B}",
      "\u{202C}",
      "\u{202D}",
      "\u{202E}",
      "\u{2066}",
      "\u{2067}",
      "\u{2068}",
      "\u{2069}",
      "\u{200E}",
      "\u{200F}",
      "\u{061C}",
      "\u{200B}",
      "\u{200C}",
      "\u{200D}",
      "\u{2060}",
      "\u{FEFF}",
      "\u{00AD}",
    ];
    for (const character of hostile) {
      const clean = sanitizeUntrustedText(`a${character}b`, {
        dialect: "plain",
        maxLength: 50,
      });
      expect(clean).toBe("ab");
    }
  });

  it("turns control whitespace into spaces and drops other controls", () => {
    const clean = sanitizeUntrustedText("one\r\ntwo\u{0000}three\u{001B}[31m", {
      dialect: "plain",
      maxLength: 200,
    });
    expect(clean).toBe("one twothree[31m");
    expect(clean).not.toContain("\u{001B}");
    expect(clean).not.toContain("\n");
  });

  it("keeps astral characters whole rather than splitting surrogates", () => {
    const clean = sanitizeUntrustedText("pay 🧾 now", {
      dialect: "plain",
      maxLength: 50,
    });
    expect(clean).toBe("pay 🧾 now");
  });

  it("escapes Slack mrkdwn metacharacters, ampersand first", () => {
    const clean = sanitizeUntrustedText("<https://evil.test|click> & <@U1>", {
      dialect: "slack_mrkdwn",
      maxLength: 200,
    });
    expect(clean).toBe("&lt;https://evil.test|click&gt; &amp; &lt;@U1&gt;");
    expect(clean).not.toContain("<");
  });

  it("escapes Telegram HTML so injected tags cannot become links", () => {
    const clean = sanitizeUntrustedText('<a href="https://evil.test">ok</a>', {
      dialect: "telegram_html",
      maxLength: 200,
    });
    expect(clean).not.toContain("<a");
    expect(clean).toContain("&lt;a href=");
  });

  it("escapes Teams Markdown link and emphasis syntax", () => {
    const clean = sanitizeUntrustedText("[click](https://evil.test) *bold*", {
      dialect: "teams_markdown",
      maxLength: 200,
    });
    expect(clean).toContain("\\[click\\]");
    expect(clean).toContain("\\*bold\\*");
  });

  it("breaks the only sequence that escapes a WeChat CDATA section", () => {
    const clean = sanitizeUntrustedText("]]><Content>evil</Content>", {
      dialect: "xml_text",
      maxLength: 200,
    });
    expect(clean).not.toContain("]]>");
    expect(clean).not.toContain("<Content>");
  });

  it("truncates before escaping, so no escape is cut in half", () => {
    // Twenty ampersands: escaped first, a cap of 12 would land inside an
    // `&amp;` and leave `&am` for the renderer to repair.
    const clean = sanitizeUntrustedText("&".repeat(20), {
      dialect: "slack_mrkdwn",
      maxLength: 12,
    });
    expect(clean.endsWith("…") || clean.endsWith("&amp;")).toBe(true);
    expect(clean).not.toMatch(/&am(?:p)?$/u);
    expect(clean.replace(/&amp;/gu, "").replace(/…/u, "")).toBe("");
  });

  it("caps length independently of the escaping that follows", () => {
    const clean = sanitizeUntrustedText("x".repeat(500), {
      dialect: "plain",
      maxLength: 20,
    });
    expect(clean).toHaveLength(20);
    expect(clean.endsWith("…")).toBe(true);
  });
});

describe("renderNotification confidentiality", () => {
  it("says only that something was asked, at minimal", () => {
    const rendered = renderNotification(
      renderInput({ confidentiality: "minimal" }),
      { dialect: "plain", channelCeiling: "full" },
    );
    expect(rendered.confidentiality).toBe("minimal");
    expect(rendered.body).toContain("rz-QHXT-KPLM");
    expect(rendered.body).not.toContain("Transfer funds");
    expect(rendered.body).not.toContain("payment.initiate");
  });

  it("adds the binding message and action label at descriptive", () => {
    const rendered = renderNotification(
      renderInput({ confidentiality: "descriptive" }),
      { dialect: "plain", channelCeiling: "full" },
    );
    expect(rendered.body).toContain("Transfer funds");
    expect(rendered.body).toContain("payment.initiate");
  });

  it("never renders raw authorization details below full", () => {
    const input = renderInput({
      confidentiality: "descriptive",
      authorizationDetails: [
        { type: "payment_initiation", creditorAccount: "DE02 1203 0000 4417" },
      ],
      requesterLabel: "agent-7",
    });
    const rendered = renderNotification(input, {
      dialect: "plain",
      channelCeiling: "full",
    });
    expect(rendered.body).not.toContain("DE02");
    expect(rendered.body).not.toContain("creditorAccount");
    expect(rendered.body).not.toContain("agent-7");
  });

  it("summarizes details by type at full and still hides their values", () => {
    const rendered = renderNotification(
      renderInput({
        confidentiality: "full",
        authorizationDetails: [
          {
            type: "payment_initiation",
            creditorAccount: "DE02 1203 0000 4417",
          },
        ],
        requesterLabel: "agent-7",
      }),
      { dialect: "plain", channelCeiling: "full" },
    );
    expect(rendered.body).toContain("payment_initiation");
    expect(rendered.body).toContain("agent-7");
    expect(rendered.body).not.toContain("DE02");
  });

  it("takes the lower of the requested level and the channel ceiling", () => {
    const rendered = renderNotification(
      renderInput({ confidentiality: "full" }),
      { dialect: "plain", channelCeiling: "minimal" },
    );
    expect(rendered.confidentiality).toBe("minimal");
    expect(rendered.body).not.toContain("Transfer funds");
  });

  it("sanitizes the binding message it does render", () => {
    const rendered = renderNotification(
      renderInput({
        confidentiality: "descriptive",
        bindingMessage: "Pay \u{202E}now\u{202C} <b>urgently</b>",
      }),
      { dialect: "telegram_html", channelCeiling: "full" },
    );
    expect(rendered.body).not.toContain("\u{202E}");
    expect(rendered.body).not.toContain("<b>");
  });

  it("bounds the rendezvous reference it echoes", () => {
    const rendered = renderNotification(
      renderInput({
        confidentiality: "minimal",
        rendezvousRef: "z".repeat(500),
      }),
      { dialect: "plain", channelCeiling: "full" },
    );
    expect(rendered.body.length).toBeLessThan(200);
  });
});

/**
 * The structural claim about comparison codes.
 *
 * `RenderInput` has no field for one — that is the real control, and it is
 * enforced by the compiler. What is testable at runtime is the consequence:
 * a six-digit-looking value pushed into every field a requester controls
 * either survives as *their own* sanitized text at a level that renders it,
 * or does not appear at all. Nothing here can mint a six-digit run of its
 * own, because nothing here is ever given one.
 */
describe("no comparison code can be rendered", () => {
  const SIX_DIGITS = /\d{6}/u;

  it("emits no six-digit run at minimal, on any dialect", () => {
    for (const dialect of DIALECTS) {
      const rendered = renderNotification(
        renderInput({
          confidentiality: "minimal",
          bindingMessage: "code 482915 approve",
          actionLabel: "719204",
          requesterLabel: "330011",
          authorizationDetails: [{ type: "556677" }],
        }),
        { dialect, channelCeiling: "full" },
      );
      expect(rendered.body).not.toMatch(SIX_DIGITS);
    }
  });

  it("emits no six-digit run that was not in the sanitized input", () => {
    const bindingMessage = "code 482915 approve";
    const actionLabel = "719204";
    const requesterLabel = "330011";
    for (const dialect of DIALECTS) {
      for (const level of ["minimal", "descriptive", "full"] as const) {
        const rendered = renderNotification(
          renderInput({
            confidentiality: level,
            bindingMessage,
            actionLabel,
            requesterLabel,
            authorizationDetails: [{ type: "556677" }],
          }),
          { dialect, channelCeiling: "full" },
        );
        const supplied = [
          bindingMessage,
          actionLabel,
          requesterLabel,
          "556677",
        ].map((text) =>
          sanitizeUntrustedText(text, {
            dialect,
            maxLength: MAX_BINDING_MESSAGE_CHARS,
          }),
        );
        for (const run of rendered.body.match(/\d{6,}/gu) ?? []) {
          expect(supplied.some((text) => text.includes(run))).toBe(true);
        }
      }
    }
  });
});
