/** @vitest-environment jsdom */
import type { CompositionSnapshot } from "@opensesame/app-core/lib/capabilities/store-types.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import {
  double,
  installDoublePorts,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import {
  addResetEmail,
  resetPasswordResetMailForTest,
} from "@opensesame/app-core/lib/password-reset-mail.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResetEmailField } from "./ResetEmailField.js";

installDoublePorts();

const state = { approved: false };

/** The double's snapshot, with exactly `approved` as the approved capabilities. */
function snapshotApproving(approved: readonly string[]): CompositionSnapshot {
  const base = double.getSnapshot();
  if (base.plan === null) throw new Error("the double resolves a plan");
  return { ...base, plan: { ...base.plan, approvedCapabilities: approved } };
}

beforeEach(() => {
  state.approved = false;
  const hidden = snapshotApproving([]);
  const shown = snapshotApproving(["ai.password-reset"]);
  Object.assign(capabilityPorts, {
    compositionStore: {
      ...double,
      getSnapshot: () => (state.approved ? shown : hidden),
    },
  });
});

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
