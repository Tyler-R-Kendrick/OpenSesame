import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  OBSERVATION_ROUTE,
  metadataSchema,
  parseObservationReceiverProvision,
} from "../lib/credential-observation/protocol.js";
import {
  sealObservation,
  verifyObservationAcknowledgement,
} from "../lib/credential-observation/seal.js";
const execute = promisify(execFile);
it("compiled receiver process creates private pairing then accepts actual sealed metadata with a genuine ACK", async () => {
  const dir = await mkdtemp(join(tmpdir(), "os-observation-cli-"));
  try {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = z.object({ port: z.number() }).parse(probe.address());
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const bundle = join(dir, "receiver.mjs");
    await build({
      entryPoints: [
        fileURLToPath(
          new URL("./credential-observation-server.ts", import.meta.url),
        ),
      ],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: bundle,
      logLevel: "silent",
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });
    const keyFile = join(dir, "pairing.json");
    const state = join(dir, "receipts.json");
    const origin = `http://127.0.0.1:${address.port}`;
    const generated = await execute(process.execPath, [
      bundle,
      "--provision",
      keyFile,
      origin,
      "--allow-loopback",
    ]);
    expect(
      z.object({ msg: z.string() }).parse(JSON.parse(generated.stdout)).msg,
    ).toBe(
      "Independent receiver pairing saved privately. Import it through owner settings.",
    );
    const p = parseObservationReceiverProvision(
      await readFile(keyFile, "utf8"),
    );
    expect(generated.stdout).not.toContain(p.independentKeyMaterialB64);
    const child = spawn(
      process.execPath,
      [bundle, keyFile, state, String(address.port)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(new Error(`Receiver exited before readiness (${code}).`)),
        );
        child.stdout.once("data", (data) => {
          expect(
            z.object({ msg: z.string() }).parse(JSON.parse(data.toString()))
              .msg,
          ).toBe("Controlled observation receiver listening on loopback.");
          resolve();
        });
      });
      const packet = await sealObservation(
        metadataSchema.parse({
          v: 1,
          eventId: crypto.randomUUID(),
          vaultIdentity: "generated-fixture",
          event: { type: "receiver_test" },
          at: new Date().toISOString(),
        }),
        p,
      );
      const response = await fetch(origin + OBSERVATION_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(packet),
        credentials: "omit",
        redirect: "error",
      });
      expect(response.status).toBe(200);
      await verifyObservationAcknowledgement(await response.text(), packet, p);
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
    await expect(readFile(`${state}.lock`)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
