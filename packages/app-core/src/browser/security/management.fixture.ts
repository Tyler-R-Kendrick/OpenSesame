import type { BoundaryValue } from "@opensesame/os-domain";
import { expect } from "vitest";
import {
  ExtensionRealmBroker,
  SECURITY_PORT,
  type SecurityReply,
  type SecurityRequest,
} from "./broker.js";
import { type PageRuntime, securityClient } from "./client.js";

export function deferred<T>() {
  let finish: (value: T) => void = () => {
    throw new Error("Deferred promise not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: (value: T) => finish(value) };
}

function managementModel() {
  const state = { revision: "protected-owner-one", now: 1000 };
  const started = deferred<void>();
  let work: Promise<string> | undefined;
  let operation: ((check: () => void) => Promise<string>) | undefined;
  let revision: Promise<string> | undefined;
  let managementCalls = 0;
  let revisionCalls = 0;
  let callbackDispatches = 0;
  let clockObserver: { remaining: number; run: () => void } | undefined;
  const broker = new ExtensionRealmBroker({
    revision: async () => {
      revisionCalls += 1;
      const pending = revision;
      revision = undefined;
      return pending ?? state.revision;
    },
    now: () => {
      const current = state.now;
      if (clockObserver && --clockObserver.remaining === 0) {
        const action = clockObserver.run;
        clockObserver = undefined;
        queueMicrotask(action);
      }
      return current;
    },
    classify: async (password) => {
      if (password === "selected-retired")
        return {
          realm: "synthetic",
          trap: {
            id: "selected-trap",
            createdAt: "2026-10-05T00:00:00.000Z",
            response: "synthetic_decoy",
          },
        };
      if (password !== "owner-current") throw new Error("Invalid owner proof");
      return { realm: "real" };
    },
    manage: async (_operation, password, check) => {
      callbackDispatches += 1;
      check();
      if (password !== "owner-current") throw new Error("Invalid owner proof");
      managementCalls += 1;
      started.finish();
      if (operation) return operation(check);
      return work ?? JSON.stringify({ selected: "owner-only-result" });
    },
  });
  return {
    broker,
    state,
    started: started.promise,
    managementCalls: () => managementCalls,
    revisionCalls: () => revisionCalls,
    callbackDispatches: () => callbackDispatches,
    afterClockReads: (remaining: number, run: () => void) => {
      clockObserver = { remaining, run };
    },
    performManagement: (callback: (check: () => void) => Promise<string>) => {
      operation = callback;
    },
    blockNextRevision: (promise: Promise<string>) => {
      revision = promise;
    },
    blockManagement: (promise: Promise<string>) => {
      work = promise;
    },
  };
}

/** Transport fixture: all real permits and replies originate in the actual worker broker. */
export function managementBridge() {
  const model = managementModel();
  const { broker, state } = model;
  let disconnect: () => void = () => undefined;
  let holdReplies = false;
  let failPosts = false;
  let attemptedPosts = 0;
  const sent: SecurityRequest[] = [];
  let message: (value: BoundaryValue) => void = () => undefined;
  const waiting: Array<(reply: SecurityReply) => void> = [];
  const queued: SecurityReply[] = [];
  const owner = broker.attach();
  const close = () => {
    owner.close();
    disconnect();
  };
  const runtime: PageRuntime = {
    connect: (options) => {
      expect(options).toEqual({ name: SECURITY_PORT });
      return {
        postMessage: (request) => {
          attemptedPosts += 1;
          if (failPosts) throw new Error("Closed worker transport");
          sent.push(request);
          void owner.handle(request).then((reply) => {
            if (holdReplies && request.op === "manage") {
              const resolve = waiting.shift();
              if (resolve) resolve(reply);
              else queued.push(reply);
            } else message(reply);
          }, close);
        },
        onMessage: {
          addListener: (listener) => {
            message = listener;
          },
        },
        onDisconnect: {
          addListener: (listener) => {
            disconnect = listener;
          },
        },
      };
    },
  };
  const client = securityClient(runtime, () => undefined);
  return {
    client,
    worker: owner,
    openWorkerPort: () => broker.attach(),
    state,
    sent,
    started: model.started,
    close,
    managementCalls: model.managementCalls,
    revisionCalls: model.revisionCalls,
    callbackDispatches: model.callbackDispatches,
    afterClockReads: model.afterClockReads,
    performManagement: model.performManagement,
    blockNextRevision: model.blockNextRevision,
    holdReplies: () => {
      holdReplies = true;
    },
    blockManagement: model.blockManagement,
    failPosts: (value: boolean) => {
      failPosts = value;
    },
    attemptedPosts: () => attemptedPosts,
    async nextReply() {
      const reply = await new Promise<SecurityReply>((resolve) => {
        const available = queued.shift();
        if (available) resolve(available);
        else waiting.push(resolve);
      });
      return { reply, deliver: () => message(reply) };
    },
  };
}
