import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearWebhookQueue,
  drainWebhookNudges,
  enqueueWebhookNudge,
} from "../webhook-queue.mjs";

test("file queue refuses a symlink without truncating its target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webhook-private-test-"));
  const saved = { ...process.env };
  try {
    Reflect.deleteProperty(process.env, "VERCEL");
    Reflect.deleteProperty(process.env, "KV_REST_API_URL");
    Reflect.deleteProperty(process.env, "KV_REST_API_TOKEN");
    const target = join(dir, "sentinel");
    const queue = join(dir, "queue.json");
    writeFileSync(target, "sentinel", { mode: 0o600 });
    symlinkSync(target, queue);
    process.env.CONNECT_WEBHOOK_QUEUE_PATH = queue;
    await assert.rejects(
      enqueueWebhookNudge({
        id: "event",
        installationId: "1",
        receivedAt: "now",
      }),
    );
    clearWebhookQueue();
    assert.equal(readFileSync(target, "utf8"), "sentinel");
    rmSync(queue);
    await enqueueWebhookNudge({
      id: "event",
      installationId: "1",
      receivedAt: "now",
    });
    assert.equal(statSync(queue).mode & 0o777, 0o600);
    assert.equal((await drainWebhookNudges("1"))[0].id, "event");
  } finally {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
