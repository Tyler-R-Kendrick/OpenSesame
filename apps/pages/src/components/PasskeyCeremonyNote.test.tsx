/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

type Support = "ok" | "missing" | "partial" | null;
const state = vi.hoisted(() => {
  const bag: { support: Support } = { support: null };
  return bag;
});

import { webauthnSeams } from "@opensesame/app-core/lib/webauthn.js";
const originalWebauthnSeams = { ...webauthnSeams };
Object.assign(webauthnSeams, {
  WEBAUTHN_FALLBACK: "This browser cannot do passkeys here.",
  detectWebAuthn: () => Promise.resolve(state.support),
});

import { PasskeyCeremonyNote } from "./PasskeyCeremonyNote.js";

describe("PasskeyCeremonyNote", () => {
  beforeEach(() => {
    state.support = null;
  });

  afterEach(cleanup);
  afterAll(() => {
    Object.assign(webauthnSeams, originalWebauthnSeams);
  });

  it("stays silent while support is unknown", () => {
    const { container } = render(<PasskeyCeremonyNote />);
    expect(container.firstChild).toBeNull();
  });

  it("stays silent when passkeys fully work", async () => {
    state.support = "ok";
    const { container } = render(<PasskeyCeremonyNote />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("says once that passkeys are missing, and offers no Mobile MFA hand-off (ADR 0140 D10)", async () => {
    state.support = "missing";
    render(<PasskeyCeremonyNote />);
    expect(
      await screen.findByText("This browser cannot do passkeys here."),
    ).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(/Mobile MFA/)).toBeNull();
  });
});
