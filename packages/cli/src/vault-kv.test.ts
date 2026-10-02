import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vfsSeams } from "@opensesame/app-core/lib/vfs.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseVaultKv, useVaultKv } from "./vault-kv.js";

const control = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  held: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (async (
      path: Parameters<typeof actual.readFile>[0],
      options?: Parameters<typeof actual.readFile>[1],
    ) => {
      if (String(path).endsWith("vault-kv.json") && control.hold) {
        const pending = control.hold;
        control.hold = null;
        control.held = true;
        await pending;
      }
      return actual.readFile(
        path,
        options as Parameters<typeof actual.readFile>[1],
      );
    }) as typeof actual.readFile,
  };
});

describe("vault kv release", () => {
  let stateDir = "";

  afterEach(async () => {
    control.hold = null;
    control.held = false;
    await releaseVaultKv();
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
    stateDir = "";
  });

  it("keeps the sealed file when a write resumes while the next open is reading", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "os-vault-kv-"));
    await useVaultKv(stateDir);
    await vfsSeams.writeRaw("vault", "sealed-body");

    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const installed = vfsSeams.writeRaw;
    vfsSeams.writeRaw = async (key, value) => {
      await gate;
      await installed(key, value);
    };
    const late = vfsSeams.writeRaw("activity", "note");
    await releaseVaultKv();

    let openRead: () => void = () => {};
    control.hold = new Promise<void>((resolve) => {
      openRead = resolve;
    });
    const reopened = useVaultKv(stateDir);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(control.held).toBe(true);
    openGate();
    await late;
    openRead();
    await reopened;

    await releaseVaultKv();
    await useVaultKv(stateDir);
    expect(vfsSeams.readRaw("vault")).toBe("sealed-body");
    const text = await readFile(join(stateDir, "vault-kv.json"), "utf8");
    expect(JSON.parse(text).vault).toBe("sealed-body");
  });
});
