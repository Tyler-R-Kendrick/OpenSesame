import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseObservationReceiverProvision } from "../lib/credential-observation/protocol.js";
import { createPrivateObservationProvision } from "./credential-observation-provision.js";
it("creates independent64B private pairing and refuses replacement or an arbitrary HTTP destination", async () => {
  const dir = await mkdtemp(join(tmpdir(), "os-observation-provision-"));
  try {
    const path = join(dir, "pairing.json");
    await createPrivateObservationProvision({
      path,
      origin: "http://127.0.0.1:18791",
      allowLoopback: true,
    });
    const raw = await readFile(path, "utf8");
    const p = parseObservationReceiverProvision(raw);
    expect(Buffer.from(p.independentKeyMaterialB64, "base64")).toHaveLength(64);
    expect((await stat(path)).mode & 0o077).toBe(0);
    await expect(
      createPrivateObservationProvision({
        path,
        origin: p.origin,
        allowLoopback: true,
      }),
    ).rejects.toThrow("already exists");
    expect(await readFile(path, "utf8")).toBe(raw);
    await expect(
      createPrivateObservationProvision({
        path: join(dir, "unsafe.json"),
        origin: "http://external.example",
        allowLoopback: true,
      }),
    ).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
