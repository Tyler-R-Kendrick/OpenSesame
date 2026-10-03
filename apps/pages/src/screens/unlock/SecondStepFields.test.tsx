/** @vitest-environment jsdom */
import type { SentCode } from "@opensesame/app-core/lib/vault/remote-code.js";
import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecondStepFields } from "./SecondStepFields.js";

afterEach(cleanup);

type Overrides = Readonly<{
  busy?: boolean;
  lockedFor?: number;
  resendIn?: number;
}>;

const SENT = {
  challengeId: "c1",
  channel: "email",
  to: "a•••@b.test",
  expiresAt: "2026-10-03T12:00:00.000Z",
} satisfies SentCode;

function draw(over: Overrides) {
  render(
    <SecondStepFields
      secondSteps={["email"]}
      activeSecondStep="email"
      recoveryMode={false}
      hasRecoveryCodes={false}
      sent={SENT}
      resendIn={over.resendIn ?? 0}
      busy={over.busy ?? false}
      lockedFor={over.lockedFor ?? 0}
      totp=""
      recovery=""
      totpRef={createRef<HTMLInputElement>()}
      onPickStep={vi.fn()}
      onTotp={vi.fn()}
      onRecovery={vi.fn()}
      onUseRecoveryCode={vi.fn()}
      onUseCode={vi.fn()}
      onResend={vi.fn()}
      onStartOver={vi.fn()}
      onComplete={vi.fn()}
    />,
  );
}

const resend = () =>
  screen.getByRole<HTMLButtonElement>("button", { name: /Send it again/ });

describe("SecondStepFields — Send it again", () => {
  it("is available during a lockout: a fresh code is not an attempt", () => {
    draw({ lockedFor: 30 });
    expect(resend().disabled).toBe(false);
    // The attempt itself is still frozen.
    expect(screen.getByLabelText("Code from the email")).toBeTruthy();
  });

  it("is off while a request is in flight", () => {
    draw({ busy: true });
    expect(resend().disabled).toBe(true);
  });

  it("is off through the resend cooldown", () => {
    draw({ resendIn: 12 });
    expect(resend().disabled).toBe(true);
    expect(resend().textContent).toContain("12s");
  });
});
