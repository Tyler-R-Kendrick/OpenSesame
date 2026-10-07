import { ExtensionRealmBroker } from "@opensesame/app-core/browser/security/broker.js";
import { expect, it } from "vitest";
import { runnerListener } from "./security-listener";
import { isOwnPage } from "./sender";
import type { RunnerService, RunnerStatus } from "./service";

const OWN = "abcdefghijklmnopabcdefghijklmnop";
const BASE = `chrome-extension://${OWN}/`;
const popup = { id: OWN, url: `${BASE}popup.html` };
const status: RunnerStatus = {
  session: true,
  privateAllowed: true,
  recovery: true,
  credentials: ["https://owner.example"],
  armed: [],
  active: [],
  candidates: [],
  lastPass: null,
};

function deferred<T>() {
  let finish: (value: T) => void = () => {
    throw new Error("Deferred promise not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: (value: T) => finish(value) };
}

async function fixture(password = "owner-current") {
  const broker = new ExtensionRealmBroker({
    revision: async () => "protected-header",
    classify: async (submitted) =>
      submitted === "selected-retired"
        ? {
            realm: "synthetic",
            trap: {
              id: "trap",
              createdAt: "2026-10-05T00:00:00.000Z",
              response: "synthetic_decoy",
            },
          }
        : { realm: "real" },
    now: () => 1000,
  });
  const client = broker.attach();
  const admission = await client.handle({ id: 1, op: "unlock", password });
  const calls: string[] = [];
  const runner: RunnerService = {
    status: async () => {
      calls.push("status");
      return status;
    },
    arm: async (origin) => {
      calls.push(`arm ${origin}`);
      return "armed";
    },
    disarm: async (origin) => {
      calls.push(`disarm ${origin}`);
    },
    tick: async () => {
      calls.push("tick");
      return {
        connected: true,
        driven: [],
        skipped: [],
        settled: 0,
        refused: 0,
      };
    },
  };
  const listen = runnerListener(runner, broker, (sender) =>
    isOwnPage(sender, OWN, BASE),
  );
  return { client, admission, calls, runner, listen };
}

it("refuses synthetic and forged permits before calling any production runner operation", async () => {
  const f = await fixture("selected-retired");
  for (const type of [
    "opensesame.runner.status",
    "opensesame.runner.arm",
    "opensesame.runner.disarm",
  ]) {
    const response = deferred<object>();
    expect(
      f.listen(
        {
          type,
          origin: "https://owner.example",
          securityPermit: f.admission.permit,
        },
        popup,
        response.finish,
      ),
    ).toBe(true);
    await expect(response.promise).resolves.toEqual({ error: "vault_locked" });
  }
  const response = deferred<object>();
  f.listen(
    { type: "opensesame.runner.status", securityPermit: "forged" },
    popup,
    response.finish,
  );
  await expect(response.promise).resolves.toEqual({ error: "vault_locked" });
  expect(f.calls).toEqual([]);
});

it("withholds production status that completes after the port is disconnected", async () => {
  const f = await fixture();
  const started = deferred<void>();
  const pendingStatus = deferred<RunnerStatus>();
  f.runner.status = async () => {
    started.finish();
    return pendingStatus.promise;
  };
  const response = deferred<object>();
  f.listen(
    { type: "opensesame.runner.status", securityPermit: f.admission.permit },
    popup,
    response.finish,
  );
  await started.promise;
  f.client.close();
  pendingStatus.finish(status);
  await expect(response.promise).resolves.toEqual({ error: "vault_locked" });
});

it("rolls back a raced arm and starts no runner tick after revocation", async () => {
  const f = await fixture();
  const started = deferred<void>();
  const pendingArm = deferred<"armed">();
  f.runner.arm = async (origin) => {
    f.calls.push(`arm ${origin}`);
    started.finish();
    return pendingArm.promise;
  };
  const response = deferred<object>();
  f.listen(
    {
      type: "opensesame.runner.arm",
      origin: "https://owner.example",
      securityPermit: f.admission.permit,
    },
    popup,
    response.finish,
  );
  await started.promise;
  await f.client.handle({ id: 2, op: "lock" });
  pendingArm.finish("armed");
  await expect(response.promise).resolves.toEqual({ error: "vault_locked" });
  expect(f.calls).toEqual([
    "arm https://owner.example",
    "disarm https://owner.example",
  ]);
});

it("answers a fresh real owner's status but ignores content-script and unrelated messages", async () => {
  const f = await fixture();
  const response = deferred<object>();
  f.listen(
    { type: "opensesame.runner.status", securityPermit: f.admission.permit },
    popup,
    response.finish,
  );
  await expect(response.promise).resolves.toEqual(status);
  const replies: object[] = [];
  expect(
    f.listen(
      { type: "opensesame.runner.status", securityPermit: f.admission.permit },
      { id: OWN, url: "https://owner.example" },
      (reply) => replies.push(reply),
    ),
  ).toBeUndefined();
  expect(
    f.listen(
      { type: "unrelated", securityPermit: f.admission.permit },
      popup,
      (reply) => replies.push(reply),
    ),
  ).toBeUndefined();
  expect(replies).toEqual([]);
  expect(f.calls).toEqual(["status"]);
});
