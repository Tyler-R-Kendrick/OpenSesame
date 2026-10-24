/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { SaveRequestScreen } from "./SaveRequestScreen.js";

const saveItem = vi.fn(async () => undefined);
const installItemTypeDefinition = vi.fn(async () => ({ ok: true }));
const original = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVaultStore: () => ({
    saveItem,
    installItemTypeDefinition,
  }),
});

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

let opener: Window;

beforeEach(() => {
  saveItem.mockClear();
  installItemTypeDefinition.mockClear();
  opener = { postMessage: vi.fn() } as unknown as Window;
  Object.defineProperty(window, "opener", {
    configurable: true,
    value: opener,
  });
});

afterEach(() => {
  cleanup();
  Object.assign(vaultHooksSeams, original);
  Object.defineProperty(window, "opener", {
    configurable: true,
    value: null,
  });
});

describe("SaveRequestScreen", () => {
  it("announces readiness, reviews a request and saves only after Save", async () => {
    render(<SaveRequestScreen />);
    await waitFor(() =>
      expect(opener.postMessage).toHaveBeenCalledWith(
        { type: "opensesame.save.ready" },
        "*",
      ),
    );
    expect(saveItem).not.toHaveBeenCalled();

    const request = {
      title: "Example login",
      fields: [
        { autocomplete: "username", value: "ada@example.test" },
        { autocomplete: "current-password", value: "correct horse" },
      ],
    };
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "opensesame.save.request",
          request: encode(request),
          itemType: "login",
        },
        origin: "https://shop.example.test",
        source: opener,
      }),
    );

    expect(await screen.findByDisplayValue("Example login")).toBeTruthy();
    expect(screen.getByText("ada@example.test")).toBeTruthy();
    expect(screen.queryByText("correct horse")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(saveItem).toHaveBeenCalledTimes(1));
    expect(opener.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "opensesame.save.saved" }),
      "https://shop.example.test",
    );
  });
});
