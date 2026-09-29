import { describe, expect, it } from "vitest";
import {
  type Arm,
  type FieldFacts,
  GESTURE_WINDOW_MS,
  type PageFacts,
  decideFill,
} from "./guard";

const NOW = 1_000_000;
const ORIGIN = "https://example.com";

const arm = (over: Partial<Arm> = {}): Arm => ({
  trigger: "command",
  origin: ORIGIN,
  armedAt: NOW - 50,
  ...over,
});

const field = (over: Partial<FieldFacts> = {}): FieldFacts => ({
  kind: "password",
  rect: { left: 100, top: 200, width: 240, height: 32 },
  viewport: { width: 1280, height: 800 },
  opacity: 1,
  visibility: "visible",
  hitSelf: true,
  disabled: false,
  ...over,
});

const page = (over: Partial<PageFacts> = {}): PageFacts => ({
  isTopFrame: true,
  origin: ORIGIN,
  passkeyOffered: false,
  field: field(),
  ...over,
});

const refusal = (a: Arm, p: PageFacts) => {
  const decision = decideFill(a, p, NOW);
  return decision.fill ? null : decision.refusal;
};

describe("a fill the person asked for", () => {
  it("fills a visible, focused password field on the exact origin", () => {
    expect(decideFill(arm(), page(), NOW)).toEqual({
      fill: true,
      field: "password",
    });
  });

  it("fills a username field from the popup too", () => {
    const p = page({ field: field({ kind: "username" }) });
    expect(decideFill(arm({ trigger: "popup" }), p, NOW)).toEqual({
      fill: true,
      field: "username",
    });
  });
});

describe("the trigger", () => {
  it("refuses a non-trusted trigger", () => {
    for (const trigger of ["page", "message", "", "click", "COMMAND"]) {
      expect(refusal(arm({ trigger }), page())).toBe("untrusted_trigger");
    }
  });

  it("refuses autofill on load", () => {
    expect(refusal(arm({ trigger: "load" }), page())).toBe("untrusted_trigger");
    expect(refusal(arm({ trigger: "navigation" }), page())).toBe(
      "untrusted_trigger",
    );
  });

  it("refuses a gesture replayed after its window", () => {
    const old = arm({ armedAt: NOW - GESTURE_WINDOW_MS - 1 });
    expect(refusal(old, page())).toBe("stale_gesture");
    expect(refusal(arm({ armedAt: NOW + 5 }), page())).toBe("stale_gesture");
    expect(refusal(arm({ armedAt: Number.NaN }), page())).toBe("stale_gesture");
  });
});

describe("the frame and its origin", () => {
  it("refuses a cross-origin iframe", () => {
    const frame = page({ isTopFrame: false, origin: "https://ads.test" });
    expect(refusal(arm(), frame)).toBe("not_top_frame");
  });

  it("refuses a same-origin iframe as well: top frame only", () => {
    expect(refusal(arm(), page({ isTopFrame: false }))).toBe("not_top_frame");
  });

  it("refuses an origin mismatch", () => {
    for (const origin of [
      "https://example.com.evil.test",
      "https://login.example.com",
      "https://example.com:8443",
      "http://example.com",
      "null",
    ]) {
      expect(refusal(arm(), page({ origin }))).toBe("origin_mismatch");
    }
  });

  it("refuses an armed origin that is not a web origin", () => {
    const opaque = arm({ origin: "null" });
    expect(refusal(opaque, page({ origin: "null" }))).toBe("origin_mismatch");
  });
});

describe("the field", () => {
  it("refuses when nothing is focused", () => {
    expect(refusal(arm(), page({ field: null }))).toBe("no_focused_field");
  });

  it("refuses a field that is not a login field", () => {
    for (const kind of ["other", "new_password"] as const) {
      expect(refusal(arm(), page({ field: field({ kind }) }))).toBe(
        "not_a_login_field",
      );
    }
  });

  it("puts passkeys first", () => {
    expect(refusal(arm(), page({ passkeyOffered: true }))).toBe(
      "passkey_offered",
    );
  });

  it("refuses a disabled field", () => {
    expect(refusal(arm(), page({ field: field({ disabled: true }) }))).toBe(
      "disabled",
    );
  });
});

describe("an invisible field (DOM-based extension clickjacking)", () => {
  const hidden = (over: Partial<FieldFacts>) =>
    refusal(arm(), page({ field: field(over) }));

  it("refuses a field at opacity 0", () => {
    expect(hidden({ opacity: 0 })).toBe("transparent");
    expect(hidden({ opacity: 0.2 })).toBe("transparent");
    expect(hidden({ opacity: Number.NaN })).toBe("transparent");
  });

  it("refuses a zero-size field", () => {
    expect(hidden({ rect: { left: 0, top: 0, width: 0, height: 0 } })).toBe(
      "zero_size",
    );
    expect(
      hidden({ rect: { left: 10, top: 10, width: 200, height: 0.5 } }),
    ).toBe("zero_size");
  });

  it("refuses a visibility:hidden field", () => {
    expect(hidden({ visibility: "hidden" })).toBe("hidden");
    expect(hidden({ visibility: "collapse" })).toBe("hidden");
  });

  it("refuses an off-screen field", () => {
    expect(
      hidden({ rect: { left: -5000, top: 10, width: 200, height: 30 } }),
    ).toBe("off_screen");
    expect(
      hidden({ rect: { left: 10, top: 9000, width: 200, height: 30 } }),
    ).toBe("off_screen");
  });

  it("refuses a field covered by an overlay", () => {
    expect(hidden({ hitSelf: false })).toBe("covered");
  });
});
