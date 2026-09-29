import { describe, expect, it } from "vitest";
import { ArmLedger, type ArmRecord, type SenderFacts } from "./admit";
import { GESTURE_WINDOW_MS } from "./guard";

const OWN = "abcdefghijklmnopabcdefghijklmnop";
const NOW = 5_000_000;

const record = (over: Partial<ArmRecord> = {}): ArmRecord => ({
  nonce: "n-1",
  tabId: 7,
  origin: "https://example.com",
  reference: "Web/example.com",
  trigger: "command",
  armedAt: NOW - 100,
  ...over,
});

const sender = (over: Partial<SenderFacts> = {}): SenderFacts => ({
  id: OWN,
  tabId: 7,
  frameId: 0,
  origin: "https://example.com",
  url: "https://example.com/login",
  ...over,
});

function attempt(s: SenderFacts, r: ArmRecord = record(), nonce = "n-1") {
  const ledger = new ArmLedger(OWN);
  ledger.arm(r);
  const admission = ledger.take(nonce, s, NOW);
  return admission.ok ? "admitted" : admission.refusal;
}

describe("the background re-checks the sender before it calls the daemon", () => {
  it("admits the armed tab's top frame on the armed origin", () => {
    expect(attempt(sender())).toBe("admitted");
  });

  it("refuses a cross-origin iframe", () => {
    const frame = sender({ frameId: 3, origin: "https://ads.test" });
    expect(attempt(frame)).toBe("not_top_frame");
  });

  it("refuses an origin mismatch", () => {
    for (const origin of [
      "https://example.com.evil.test",
      "https://login.example.com",
      "http://example.com",
      "https://example.com:8443",
    ]) {
      expect(attempt(sender({ origin }))).toBe("origin_mismatch");
    }
  });

  it("falls back to the sender URL's origin when the browser gives no origin", () => {
    expect(
      attempt(sender({ origin: undefined, url: "https://example.com/x" })),
    ).toBe("admitted");
    expect(
      attempt(sender({ origin: undefined, url: "https://evil.test/x" })),
    ).toBe("origin_mismatch");
  });

  it("refuses another tab", () => {
    expect(attempt(sender({ tabId: 8 }))).toBe("wrong_tab");
  });

  it("refuses another extension", () => {
    expect(attempt(sender({ id: "ponmlkjihgfedcbaponmlkjihgfedcba" }))).toBe(
      "foreign_sender",
    );
  });

  it("refuses a non-trusted trigger: nothing armed, nothing admitted", () => {
    expect(attempt(sender(), record(), "made-up-by-the-page")).toBe(
      "unknown_gesture",
    );
    expect(attempt(sender(), record(), "")).toBe("unknown_gesture");
  });

  it("refuses a stale gesture", () => {
    const old = record({ armedAt: NOW - GESTURE_WINDOW_MS - 1 });
    expect(attempt(sender(), old)).toBe("unknown_gesture");
  });

  it("spends a gesture on its first attempt, admitted or not", () => {
    const ledger = new ArmLedger(OWN);
    ledger.arm(record());
    expect(ledger.take("n-1", sender({ frameId: 2 }), NOW).ok).toBe(false);
    expect(ledger.take("n-1", sender(), NOW)).toEqual({
      ok: false,
      refusal: "unknown_gesture",
    });
    ledger.arm(record({ nonce: "n-2" }));
    expect(ledger.take("n-2", sender(), NOW).ok).toBe(true);
    expect(ledger.take("n-2", sender(), NOW).ok).toBe(false);
    expect(ledger.size).toBe(0);
  });
});
