import { cleanup, render, screen, waitFor } from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import { listNotices } from "@opensesame/app-core/lib/notices.js";
import { totpSeams } from "@opensesame/vault-core";
import { TotpCode, currentTotp } from "./TotpCode.js";
import { expectInTray, inTray } from "./tray.test-support.js";

/** RFC 6238 Appendix B seed ("12345678901234567890" in base32). */
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const originalTotpSeams = { ...totpSeams };
const mockedTotpCode = vi.fn(originalTotpSeams.totpCode);
const mockedParseTotp = vi.fn(originalTotpSeams.parseTotp);
const mockedSecondsRemaining = vi.fn(originalTotpSeams.secondsRemaining);
Object.assign(totpSeams, {
  totpCode: mockedTotpCode,
  parseTotp: mockedParseTotp,
  secondsRemaining: mockedSecondsRemaining,
});

describe("TotpCode", () => {
  afterEach(() => {
    cleanup();
    mockedTotpCode.mockReset().mockImplementation(originalTotpSeams.totpCode);
    mockedParseTotp.mockReset().mockImplementation(originalTotpSeams.parseTotp);
    mockedSecondsRemaining
      .mockReset()
      .mockImplementation(originalTotpSeams.secondsRemaining);
  });

  it("renders the current code grouped in threes with a countdown ring", async () => {
    render(<TotpCode secret={SEED} />);
    const code = await screen.findByText(/^\d{3} \d{3}$/);
    expect(code).toBeTruthy();
    const ring = screen.getByRole("img", { name: /seconds remaining/ });
    expect(ring.getAttribute("aria-label")).toMatch(/^\d+ seconds remaining$/);
  });

  it("does not group codes that are not six digits", async () => {
    render(
      <TotpCode
        secret={`otpauth://totp/Ex:a?secret=${SEED}&digits=8&period=30`}
      />,
    );
    const code = await screen.findByText(/^\d{8}$/);
    expect(code).toBeTruthy();
  });

  it("surfaces parse errors for unreadable secrets", async () => {
    render(<TotpCode secret="not a secret at all!" />);
    await expectInTray(/base32|secret|character/i);
    expect(
      screen.getByRole("img", { name: /base32|secret|character/i }),
    ).toBeTruthy();
    expect(mockedTotpCode).not.toHaveBeenCalled();
  });

  it("reports generation failures without crashing", async () => {
    mockedTotpCode.mockRejectedValueOnce(new Error("hmac exploded"));
    render(<TotpCode secret={SEED} />);
    await expectInTray("This authenticator code could not be generated.");
    expect(
      screen.getByRole("img", {
        name: "This authenticator code could not be generated.",
      }),
    ).toBeTruthy();
  });

  it("clears its notice when the secret is fixed", async () => {
    const { rerender } = render(
      <TotpCode id="item-1" secret="not a secret!" />,
    );
    await expectInTray(/base32|secret|character/i);
    rerender(<TotpCode id="item-1" secret={SEED} />);
    await screen.findByText(/^\d{3} \d{3}$/);
    await waitFor(() => expect(inTray(/base32|secret|character/i)).toBe(false));
    expect(
      screen.queryByRole("img", { name: /base32|secret|character/i }),
    ).toBeNull();
  });

  it("keeps one notice per item across remounts", async () => {
    const first = render(<TotpCode id="item-2" secret="not a secret!" />);
    await expectInTray(/base32|secret|character/i);
    first.unmount();
    render(<TotpCode id="item-2" secret="not a secret!" />);
    await expectInTray(/base32|secret|character/i);
    expect(
      listNotices().filter((notice) => notice.title === "Authenticator code"),
    ).toHaveLength(1);
  });

  it("uses a generic message when parsing fails unexpectedly", async () => {
    mockedParseTotp.mockImplementationOnce(() => {
      throw new TypeError("not a parse error");
    });
    render(<TotpCode secret={SEED} />);
    await expectInTray("This authenticator secret could not be read.");
  });

  it("marks the code as expiring in the last seconds of the period", async () => {
    mockedSecondsRemaining.mockReturnValue(3);
    const { container } = render(<TotpCode secret={SEED} />);
    await screen.findByText(/^\d{3} \d{3}$/);
    expect(
      screen.getByRole("img", { name: "3 seconds remaining" }),
    ).toBeTruthy();
    expect(container.querySelector(".totp--expiring")).toBeTruthy();
  });

  it("reschedules tightly on the period boundary", async () => {
    mockedSecondsRemaining.mockReturnValue(1);
    render(<TotpCode secret={SEED} />);
    expect(await screen.findByText(/^\d{3} \d{3}$/)).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "1 seconds remaining" }),
    ).toBeTruthy();
  });

  it("re-reads a changed secret instead of showing the old code", async () => {
    const { rerender } = render(<TotpCode secret={SEED} />);
    await screen.findByText(/^\d{3} \d{3}$/);
    rerender(
      <TotpCode
        secret={`otpauth://totp/Ex:a?secret=${SEED}&digits=8&period=30`}
      />,
    );
    expect(await screen.findByText(/^\d{8}$/)).toBeTruthy();
  });
});

describe("currentTotp", () => {
  afterEach(() => {
    mockedTotpCode.mockReset().mockImplementation(originalTotpSeams.totpCode);
  });

  it("returns the raw current code", async () => {
    const code = await currentTotp(SEED);
    expect(code).toMatch(/^\d{6}$/);
  });
});
