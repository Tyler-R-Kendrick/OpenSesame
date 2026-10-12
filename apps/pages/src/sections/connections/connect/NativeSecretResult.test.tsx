/** @vitest-environment jsdom */
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { clearCopiedSecret } from "../../../lib/vault/hooks.js";
import { NativeSecretResult } from "./NativeSecretResult.js";

const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
afterEach(() => {
  cleanup();
  if (originalClipboard)
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

it("masks an explicitly read secret and uses the existing protected clipboard path only when requested", async () => {
  const clipboard = {
    writeText: vi.fn(async (_value: string) => undefined),
    readText: vi.fn(async () => "returned-private-value"),
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
  act(() => vaultStore.setPrefs({ clipboardClearSeconds: 0 }));
  const rendered = render(
    <NativeSecretResult
      label="Database password"
      value="returned-private-value"
    />,
  );
  expect(rendered.container.textContent).not.toContain(
    "returned-private-value",
  );
  expect(clipboard.writeText).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Reveal Database password" }),
  );
  expect(rendered.container.textContent).toContain("returned-private-value");
  await userEvent.click(
    screen.getByRole("button", { name: "Hide Database password" }),
  );
  expect(rendered.container.textContent).not.toContain(
    "returned-private-value",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Copy Database password" }),
  );
  expect(clipboard.writeText).toHaveBeenCalledWith("returned-private-value");
  clearCopiedSecret();
  await waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith(""));
  rendered.unmount();
  expect(document.body.textContent).not.toContain("returned-private-value");
});
