/** @vitest-environment jsdom */
/**
 * Copy only (`use`) must not write a concealed secret to the joiner's
 * clipboard. Show values still may, when the joiner asks.
 */
import type { Catalog } from "@opensesame/app-core/lib/live/messages.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCopiedSecret } from "../../lib/vault/hooks.js";
import { LiveCatalog } from "./LiveCatalog.js";

const SECRET = "correct horse battery staple";

function catalog(policy: Catalog["policy"]): Catalog {
  return {
    title: "Team",
    policy,
    expiresAt: Date.now() + 60_000,
    items: [
      {
        id: "github",
        name: "GitHub",
        type: "account",
        fields: [
          {
            key: "username",
            label: "Username",
            concealed: false,
            value: "octo",
          },
          {
            key: "password",
            label: "Password",
            concealed: true,
            value: null,
          },
        ],
      },
    ],
  };
}

function stubClipboard() {
  const clipboard = {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(""),
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
  return clipboard;
}

afterEach(() => {
  clearCopiedSecret();
  cleanup();
});

describe("Copy only and the joiner clipboard", () => {
  it("does not write secret plaintext to the clipboard", async () => {
    const clipboard = stubClipboard();
    const request = vi.fn(async () => SECRET);
    render(<LiveCatalog catalog={catalog("use")} request={request} />);
    const copyPassword = screen.queryByRole("button", {
      name: "Copy GitHub Password",
    });
    if (copyPassword) fireEvent.click(copyPassword);
    expect(copyPassword).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(clipboard.writeText.mock.calls.flat()).not.toContain(SECRET);
  });

  it("still copies when the session shows values", async () => {
    const clipboard = stubClipboard();
    const request = vi.fn(async (what: "reveal" | "copy") =>
      what === "copy" ? SECRET : null,
    );
    render(<LiveCatalog catalog={catalog("read")} request={request} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Copy GitHub Password" }),
    );
    await waitFor(() =>
      expect(clipboard.writeText).toHaveBeenCalledWith(SECRET),
    );
    expect(request).toHaveBeenCalledWith("copy", "github", "password");
  });
});
