import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { configureHost, host } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { redactError } from "./errors.js";
import { type SopsResponse, parseRequest } from "./protocol.js";
import { NEVER, TestSession, newIdentity } from "./test-support.js";
import { SopsWorkerClient } from "./worker-client.js";

class ControlledWorker extends EventTarget {
  static instances: ControlledWorker[] = [];
  readonly session = new TestSession();
  pending: { ready: Promise<SopsResponse>; release: () => Promise<void> }[] =
    [];
  terminated = false;
  constructor() {
    super();
    ControlledWorker.instances.push(this);
  }
  terminate() {
    this.terminated = true;
  }
  postMessage(value: BoundaryValue) {
    const request = parseRequest(value);
    const deliver = (response: SopsResponse) =>
      this.dispatchEvent(new MessageEvent("message", { data: response }));
    if (request.kind === "open") {
      const ready: Promise<SopsResponse> = this.session.engine
        .open(request.text, request.format, {
          identities: request.identities,
          permit: request.permit,
          signal: NEVER,
        })
        .then(
          (result) => ({
            id: request.id,
            ok: true as const,
            kind: "open" as const,
            ...result,
          }),
          (caught) => {
            const error = redactError(caught, "invalid_document");
            return {
              id: request.id,
              ok: false as const,
              code: error.code,
              message: error.message,
            };
          },
        );
      this.pending.push({
        ready,
        release: async () => {
          deliver(await ready);
        },
      });
    } else if (request.kind === "inspect") {
      queueMicrotask(() =>
        deliver({
          id: request.id,
          ok: true,
          kind: "inspect",
          inspection: this.session.engine.inspect(request.text, request.format),
        }),
      );
    } else if (request.kind === "invalidate") {
      this.session.generation = request.generation;
      this.session.engine.disposeAll();
      queueMicrotask(() => deliver({ id: request.id, ok: true, kind: "done" }));
    }
  }
}

it("worker invalidation rejects held plaintext, drops late replies and creates an independent successor worker", async () => {
  const original = host();
  const identity = await newIdentity();
  const engine = new TestSession();
  const { plan, permit } = await engine.plan("json", [[identity.recipient]]);
  const ciphertext = await engine.engine.encryptNew(
    '{"secret":"controlled-worker-value"}',
    { plan, permit, signal: NEVER },
  );
  // SAFETY: finite constructor implements only the EventTarget/postMessage/terminate Worker boundary the client uses.
  configureHost({
    ...createTestHost(),
    worker: overlapCast<typeof ControlledWorker, typeof Worker>(
      ControlledWorker,
    ),
  });
  ControlledWorker.instances = [];
  const client = new SopsWorkerClient();
  try {
    const positive = client.open(
      ciphertext,
      "json",
      [identity.identity],
      engine.permit(),
    );
    const firstWorker = ControlledWorker.instances[0];
    if (!firstWorker) throw new Error("No positive worker");
    const releasePositive = firstWorker.pending.shift();
    if (!releasePositive) throw new Error("No positive operation");
    await releasePositive.release();
    const opened = await positive;
    expect(JSON.parse(opened.plaintext)).toEqual({
      secret: "controlled-worker-value",
    });
    const opening = client.open(
      ciphertext,
      "json",
      [identity.identity],
      engine.permit(),
    );
    const rejected = expect(opening).rejects.toMatchObject({
      code: "stale_session",
    });
    const old = ControlledWorker.instances[0];
    if (!old) throw new Error("No original worker");
    const delayed = old.pending.shift();
    if (!delayed) throw new Error("No held original operation");
    const actualReply = await delayed.ready;
    expect(actualReply).toMatchObject({ ok: true, kind: "open" });
    client.invalidate(1);
    await rejected;
    await Promise.resolve();
    expect(old.terminated).toBe(true);
    await delayed.release();
    const inspection = await client.inspect(ciphertext, "json");
    expect(inspection.keyGroups).toHaveLength(1);
    expect(ControlledWorker.instances).toHaveLength(2);
    const successor = ControlledWorker.instances[1];
    if (!successor) throw new Error("No successor worker");
    const held = client.open(
      ciphertext,
      "json",
      [identity.identity],
      engine.permit(),
    );
    const stopped = expect(held).rejects.toMatchObject({ code: "canceled" });
    successor.dispatchEvent(new Event("error"));
    await stopped;
  } finally {
    client.invalidate(2);
    for (const worker of ControlledWorker.instances) {
      await Promise.all(worker.pending.map((operation) => operation.ready));
      worker.session.engine.disposeAll();
    }
    engine.engine.disposeAll();
    configureHost(original);
  }
});
