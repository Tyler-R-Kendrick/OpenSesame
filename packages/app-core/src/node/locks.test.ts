import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createNodeLocks } from "./locks.js";
let directory = "";
let fixture = "";
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "opensesame-lock-proof-"));
  fixture = join(directory, "process.mjs");
  await build({
    entryPoints: ["src/node/fixtures/lock-process.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: fixture,
    logLevel: "silent",
  });
});
afterEach(() => rmSync(directory, { force: true, recursive: true }));
function start(operation: string) {
  return spawn(
    process.execPath,
    [fixture, join(directory, "locks"), join(directory, "output"), operation],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
}
function completed(child: ReturnType<typeof start>): Promise<void> {
  return new Promise((resolve, reject) => {
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(errors)),
    );
  });
}
function ready(child: ReturnType<typeof start>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdout.once("data", (chunk: Buffer) => {
      if (chunk.toString() === "ready\n") resolve();
      else reject(new Error("Unexpected SQLite holder readiness."));
    });
    child.once("error", reject);
    child.once("exit", () =>
      reject(new Error("SQLite holder exited before readiness.")),
    );
  });
}
it("serializes independent operating-system processes through the same lock", async () => {
  await Promise.all(Array.from({ length: 4 }, () => completed(start("write"))));
  expect(readFileSync(join(directory, "output"), "utf8")).toBe(
    "start\nend\n".repeat(4),
  );
});
it("releases a killed holder and refuses unavailable acquisition without invoking authority", async () => {
  const child = start("hold");
  while (!existsSync(join(directory, "output.ready"))) {
    if (child.exitCode !== null)
      throw new Error("Holder failed to acquire lock.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  const locks = createNodeLocks(join(directory, "locks"));
  await expect(
    locks.request(
      "process-proof",
      { ifAvailable: true },
      (lock) => lock === null,
    ),
  ).resolves.toBe(true);
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGKILL");
  await exited;
  await completed(start("write"));
  expect(readFileSync(join(directory, "output"), "utf8")).toBe("start\nend\n");
});
it("handles initialization contention without admitting unavailable or cancelled authority", async () => {
  const holder = start("exclusive");
  const exited = completed(holder);
  await ready(holder);
  const locks = createNodeLocks(join(directory, "locks"));
  let authorityCalls = 0;
  let unavailableCalls = 0;
  let queued: Promise<void> | undefined;
  try {
    await expect(
      locks.request("process-proof", { ifAvailable: true }, (lock) => {
        unavailableCalls += 1;
        expect(lock).toBeNull();
      }),
    ).resolves.toBeUndefined();
    const controller = new AbortController();
    const cancelled = locks.request(
      "process-proof",
      { signal: controller.signal },
      () => {
        authorityCalls += 1;
      },
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    queued = locks.request("process-proof", () => {
      authorityCalls += 1;
    });
    expect(authorityCalls).toBe(0);
    expect(unavailableCalls).toBe(1);
  } finally {
    holder.stdin.end("release");
    await exited;
    await queued;
  }
  expect(authorityCalls).toBe(1);
});
it("retains ownership while a reader delays commit and never replays the authority callback", async () => {
  const reader = start("reader");
  const exited = completed(reader);
  await ready(reader);
  const path = join(
    directory,
    "locks",
    `${createHash("sha256").update("process-proof").digest("hex")}.sqlite`,
  );
  const probe = new DatabaseSync(path);
  const locks = createNodeLocks(join(directory, "locks"));
  let calls = 0;
  let settled = false;
  let refusal: Error | undefined;
  const controller = new AbortController();
  const committed = locks
    .request("process-proof", { signal: controller.signal }, () => {
      calls += 1;
      controller.abort();
      // The callback's side effects must occur once, before any successor enters.
      appendFileSync(join(directory, "output"), "start\nend\n");
    })
    .then(
      () => {
        settled = true;
      },
      (error: Error) => {
        settled = true;
        refusal = error;
      },
    );
  try {
    let pending = false;
    while (!pending && !settled) {
      try {
        probe.prepare("SELECT * FROM mutex_marker").all();
      } catch (error) {
        expect(error).toMatchObject({ errcode: 5 });
        pending = true;
      }
      if (!pending)
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    if (refusal) throw refusal;
    expect(pending).toBe(true);
    expect(settled).toBe(false);
    expect(calls).toBe(1);
    await expect(
      locks.request(
        "process-proof",
        { ifAvailable: true },
        (lock) => lock === null,
      ),
    ).resolves.toBe(true);
    expect(readFileSync(join(directory, "output"), "utf8")).toBe(
      "start\nend\n",
    );
  } finally {
    probe.close();
    reader.stdin.end("release");
    await exited;
    await committed;
  }
  if (refusal) throw refusal;
  await completed(start("write"));
  expect(calls).toBe(1);
  expect(readFileSync(join(directory, "output"), "utf8")).toBe(
    "start\nend\n".repeat(2),
  );
});
it("propagates an authority failure once and releases the transaction", async () => {
  const locks = createNodeLocks(join(directory, "locks"));
  const failure = new Error("Generated authority refusal.");
  let calls = 0;
  await expect(
    locks.request("process-proof", () => {
      calls += 1;
      throw failure;
    }),
  ).rejects.toBe(failure);
  await completed(start("write"));
  expect(calls).toBe(1);
  expect(readFileSync(join(directory, "output"), "utf8")).toBe("start\nend\n");
});
it("fails closed on a malformed SQLite database without invoking authority", async () => {
  const lockDirectory = join(directory, "locks");
  mkdirSync(lockDirectory, { mode: 0o700 });
  const path = join(
    lockDirectory,
    `${createHash("sha256").update("process-proof").digest("hex")}.sqlite`,
  );
  writeFileSync(path, "Generated invalid SQLite fixture.");
  let calls = 0;
  await expect(
    createNodeLocks(lockDirectory).request(
      "process-proof",
      { ifAvailable: true },
      () => {
        calls += 1;
      },
    ),
  ).rejects.toMatchObject({ errcode: 26 });
  expect(calls).toBe(0);
});
