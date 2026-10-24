import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeClipboard } from "./vault-clipboard.js";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("vault clipboard helpers", () => {
  it("falls through a helper that closes before reading stdin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensesame-clipboard-"));
    const helper = join(directory, "wl-copy");
    await writeFile(helper, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await chmod(helper, 0o700);
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    // No later tool is installed in this test PATH. The point is that the
    // early-closing helper rejects instead of crashing on an EPIPE.
    await expect(writeClipboard("secret")).rejects.toThrow(
      /No clipboard tool accepted/,
    );
  });
});
