/** @vitest-environment jsdom */
import type { LiveLink } from "@opensesame/app-core/lib/live/link.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearJoinDraft, joinDraft } from "./live-hooks.js";
import { useAsk } from "./live-join-ask-state.js";
import { LiveJoinAskForm } from "./live-join-route-parts.js";

const link: LiveLink = {
  admission: "open",
  owner: "A".repeat(87),
  secret: "A".repeat(43),
  routes: null,
};

beforeEach(() => {
  clearJoinDraft();
  joinDraft.name = "  Alex  ";
});
afterEach(cleanup);

describe("the live join ask", () => {
  it("needs only a name when the link already carries the session", () => {
    const { result } = renderHook(() => useAsk(link));
    expect(result.current.ready).toBe(true);
    expect(result.current.cleanedName).toBe("Alex");
    act(() => result.current.set.setName("   "));
    expect(result.current.ready).toBe(false);
    act(() => result.current.set.setName("Grace"));
    expect(result.current.ready).toBe(true);
  });

  it("asks only for an invite code on an invite link", () => {
    const { result, rerender } = renderHook(
      ({ held }: { held: LiveLink }) => useAsk(held),
      { initialProps: { held: { ...link, admission: "invite" } } },
    );
    expect(result.current.needsCode).toBe(true);
    expect(result.current.ready).toBe(false);
    act(() => result.current.set.setCode("bcdf-ghjk"));
    expect(result.current.normalized).toBe("BCDF-GHJK");
    expect(result.current.ready).toBe(true);
    rerender({ held: { ...link, routes: "!" } });
    expect(result.current.link).toBeNull();
    expect(result.current.ready).toBe(false);
  });

  it("draws name and optional note only, with the disabled reason visible", () => {
    clearJoinDraft();
    const form = within(render(<LiveJoinAskForm held={link} />).container);
    expect(form.getAllByRole("textbox").map((field) => field.id)).toEqual([
      "live-name",
      "live-note",
    ]);
    expect(form.queryByLabelText("Device PIN")).toBeNull();
    expect(form.getByText("Name is required")).toBeTruthy();
    fireEvent.change(form.getByLabelText("Your name"), {
      target: { value: "Grace" },
    });
    expect(
      form
        .getByRole("button", { name: "Ask to join" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});
