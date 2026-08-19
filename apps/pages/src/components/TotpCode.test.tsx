import { cleanup, render, screen, waitFor } from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/vault/totp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/vault/totp.js")>();
  return {
    ...actual,
    parseTotp: vi.fn(actual.parseTotp),
    secondsRemaining: vi.fn(actual.secondsRemaining),
    totpCode: vi.fn(actual.totpCode),
  };
});

import { parseTotp, secondsRemaining, totpCode } from "../lib/vault/totp.js";
import { TotpCode, currentTotp } from "./TotpCode.js";

/** RFC 6238 Appendix B seed ("12345678901234567890" in base32). */
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const mockedTotpCode = vi.mocked(totpCode);
const mockedParseTotp = vi.mocked(parseTotp);
const mockedSecondsRemaining = vi.mocked(secondsRemaining);

const actualTotp = await vi.importActual<typeof import("../lib/vault/totp.js")>(
  "../lib/vault/totp.js",
);

describe("TotpCode", () => {
  afterEach(() => {
    cleanup();
    mockedTotpCode.mockReset().mockImplementation(actualTotp.totpCode);
    mockedParseTotp.mockReset().mockImplementation(actualTotp.parseTotp);
    mockedSecondsRemaining
      .mockReset()
      .mockImplementation(actualTotp.secondsRemaining);
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
    expect(await screen.findByText(/base32|secret|character/i)).toBeTruthy();
    expect(mockedTotpCode).not.toHaveBeenCalled();
  });

  it("reports generation failures without crashing", async () => {
    mockedTotpCode.mockRejectedValueOnce(new Error("hmac exploded"));
    render(<TotpCode secret={SEED} />);
    expect(
      await screen.findByText(
        "This authenticator code could not be generated.",
      ),
    ).toBeTruthy();
  });

  it("uses a generic message when parsing fails unexpectedly", async () => {
    mockedParseTotp.mockImplementationOnce(() => {
      throw new TypeError("not a parse error");
    });
    render(<TotpCode secret={SEED} />);
    expect(
      await screen.findByText("This authenticator secret could not be read."),
    ).toBeTruthy();
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
    mockedTotpCode.mockReset().mockImplementation(actualTotp.totpCode);
  });

  it("returns the raw current code", async () => {
    const code = await currentTotp(SEED);
    expect(code).toMatch(/^\d{6}$/);
  });
});
