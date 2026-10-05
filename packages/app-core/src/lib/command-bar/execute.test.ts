import { describe, expect, it, vi } from "vitest";
import { executeCommand } from "./execute.js";

describe("executeCommand › search", () => {
  it("lists everything, narrowed to the query, so a phone lands on a list", async () => {
    const navigate = vi.fn();
    const outcome = await executeCommand(
      { action: "search", query: "git hub" },
      {
        navigate,
        copy: vi.fn(),
        items: () => [],
        vaultLocked: () => false,
      },
    );
    expect(navigate).toHaveBeenCalledWith("/vault?f=all&q=git%20hub");
    expect(outcome).toEqual({ ok: true, message: "Searching for “git hub”" });
  });
});
