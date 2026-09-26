/** @vitest-environment jsdom */
import { initialDraftState } from "@opensesame/app-core/lib/connect-draft.js";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorizationParams, ScopeFields } from "./ScopeFields.js";

afterEach(cleanup);

describe("another scope", () => {
  it("adds the scope on Enter instead of saving the form around it", async () => {
    const plan = connectPlan("notion");
    if (!plan) throw new Error("no notion plan");
    const onState = vi.fn();
    const submit = vi.fn((event: SubmitEvent) => event.preventDefault());
    const { container } = render(
      <form>
        <ScopeFields
          plan={plan}
          state={initialDraftState(plan, "oauth")}
          onState={onState}
        />
      </form>,
    );
    container.querySelector("form")?.addEventListener("submit", submit);
    await userEvent.type(
      screen.getByLabelText("Another scope"),
      "extra:scope{Enter}",
    );
    expect(submit).not.toHaveBeenCalled();
    expect(onState.mock.lastCall?.[0].oauth.scopes).toContain("extra:scope");
  });
});

function Params({
  onParams,
}: { onParams: (p: Record<string, string>) => void }) {
  const [params, setParams] = useState<Record<string, string>>({
    prompt: "consent",
  });
  return (
    <AuthorizationParams
      params={params}
      onParams={(next) => {
        setParams(next);
        onParams(next);
      }}
    />
  );
}

describe("authorization params", () => {
  it("keeps a row being typed in, and never loses an earlier row's value", async () => {
    const onParams = vi.fn();
    render(<Params onParams={onParams} />);
    await userEvent.click(screen.getByRole("button", { name: "Add param" }));
    await userEvent.type(screen.getByLabelText("Param 2"), "prompt");
    expect(screen.getByLabelText("Param 2")).toHaveProperty("value", "prompt");
    expect(screen.getByLabelText("Param 1 value")).toHaveProperty(
      "value",
      "consent",
    );
    expect(onParams.mock.lastCall?.[0]).toEqual({ prompt: "consent" });
    await userEvent.clear(screen.getByLabelText("Param 2"));
    await userEvent.type(screen.getByLabelText("Param 2"), "login_hint");
    await userEvent.type(
      screen.getByLabelText("Param 2 value"),
      "a@example.com",
    );
    expect(onParams.mock.lastCall?.[0]).toEqual({
      prompt: "consent",
      login_hint: "a@example.com",
    });
  });

  it("offers another blank row while one is still blank", async () => {
    render(<Params onParams={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Add param" }));
    await userEvent.click(screen.getByRole("button", { name: "Add param" }));
    expect(screen.getByLabelText("Param 3")).toBeTruthy();
  });
});
