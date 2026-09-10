/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { draftSuggestionSeams } from "../../lib/vault/draft-suggestions.js";
import { DraftSuggestions } from "./DraftSuggestions.js";

const original = draftSuggestionSeams.model;
afterEach(() => {
  cleanup();
  draftSuggestionSeams.model = original;
});

describe("draft suggestion consent and lifetime", () => {
  it("never invokes the model on render and applies only after preview approval", async () => {
    const create = vi.fn(async () => ({
      prompt: async () => '{"name":"Quiet login","username":"quiet_fox"}',
      destroy: vi.fn(),
    }));
    draftSuggestionSeams.model = () => ({
      availability: async () => "available",
      create,
    });
    const apply = vi.fn();
    render(
      <DraftSuggestions
        typeId="login"
        website="https://example.com/private-path"
        onApply={apply}
      />,
    );
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByText(/Uses only/).textContent).not.toContain(
      "private-path",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Suggest names on device" }),
    );
    const accept = await screen.findByRole("button", { name: "Use names" });
    expect(apply).not.toHaveBeenCalled();
    await userEvent.click(accept);
    expect(apply).toHaveBeenCalledWith({
      name: "Quiet login",
      username: "quiet_fox",
    });
  });
  it("leaves the draft alone when the model is unavailable", async () => {
    draftSuggestionSeams.model = () => null;
    const apply = vi.fn();
    render(<DraftSuggestions typeId="secret" onApply={apply} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Suggest names on device" }),
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      "unavailable",
    );
    expect(apply).not.toHaveBeenCalled();
  });
  it("aborts and destroys a model request when the ceremony closes", async () => {
    const destroy = vi.fn();
    let captured: AbortSignal | undefined;
    draftSuggestionSeams.model = () => ({
      availability: async () => "available",
      create: async () => ({
        destroy,
        prompt: (_input, { signal }) =>
          new Promise<string>((_resolve, reject) => {
            captured = signal;
            signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
      }),
    });
    const apply = vi.fn();
    const { unmount } = render(
      <DraftSuggestions typeId="login" onApply={apply} />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Suggest names on device" }),
    );
    await waitFor(() => expect(captured).toBeDefined());
    unmount();
    expect(captured?.aborted).toBe(true);
    await waitFor(() => expect(destroy).toHaveBeenCalledOnce());
    expect(apply).not.toHaveBeenCalled();
  });
});
