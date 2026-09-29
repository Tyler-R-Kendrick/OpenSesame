/** @vitest-environment jsdom */
import {
  addResetEmail,
  resetPasswordResetMailForTest,
} from "@opensesame/app-core/lib/password-reset-mail.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ approved: false }));

vi.mock("../../bindings/capabilities.js", () => ({
  useComposition: () => ({
    plan: {
      approvedCapabilities: state.approved ? ["ai.password-reset"] : [],
    },
  }),
}));

import { ResetEmailField } from "./ResetEmailField.js";

afterEach(() => {
  cleanup();
  state.approved = false;
  resetPasswordResetMailForTest();
});

describe("ResetEmailField", () => {
  it("stays hidden until password reset is on and a mailbox exists", () => {
    addResetEmail("a@example.com");
    const { container, rerender } = render(
      <ResetEmailField emailId={undefined} onChange={() => {}} />,
    );
    expect(container.querySelector("select")).toBeNull();
    state.approved = true;
    rerender(<ResetEmailField emailId={undefined} onChange={() => {}} />);
    expect(screen.getByRole("combobox", { name: "Reset email" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "a@example.com" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "None" })).toBeTruthy();
  });

  it("writes the chosen mailbox id", () => {
    state.approved = true;
    const email = addResetEmail("a@example.com");
    const chosen: Array<string | undefined> = [];
    render(
      <ResetEmailField
        emailId={undefined}
        onChange={(id) => chosen.push(id)}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Reset email" }), {
      target: { value: email?.id },
    });
    expect(chosen).toEqual([email?.id]);
    fireEvent.change(screen.getByRole("combobox", { name: "Reset email" }), {
      target: { value: "" },
    });
    expect(chosen).toEqual([email?.id, undefined]);
  });
});
