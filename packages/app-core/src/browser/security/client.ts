import type { BoundaryValue } from "@opensesame/os-domain";
import {
  SECURITY_PORT,
  type SecurityReply,
  type SecurityRequest,
  securityReply,
} from "./broker.js";
import type { ManagementOperation } from "./management-wire.js";
export type PagePort = {
  postMessage(message: SecurityRequest): void;
  onMessage: { addListener(listener: (message: BoundaryValue) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
};
export type PageRuntime = { connect(options: { name: string }): PagePort };
/** A permit is held only by this page and dies with its worker port. */
export function securityClient(runtime: PageRuntime, disconnected: () => void) {
  const port = runtime.connect({ name: SECURITY_PORT });
  const pending = new Map<number, (reply: SecurityReply) => void>();
  let next = 0;
  let generation = 0;
  let connected = true;
  let permit: string | undefined;
  const clear = () => {
    generation += 1;
    permit = undefined;
    for (const [id, resolve] of pending) resolve({ id, realm: "locked" });
    pending.clear();
  };
  port.onMessage.addListener((message) => {
    const parsed = securityReply.safeParse(message);
    if (!parsed.success) return;
    const resolve = pending.get(parsed.data.id);
    pending.delete(parsed.data.id);
    resolve?.(parsed.data);
  });
  port.onDisconnect.addListener(() => {
    connected = false;
    clear();
    disconnected();
  });
  return {
    permit: () => permit,
    async authorize() {
      if (!connected || pending.size >= 32) return false;
      const expected = generation;
      const id = next++;
      const reply = await requestReply(port, pending, {
        id,
        op: "authorize",
        permit,
      });
      return reply.realm === "real" && connected && expected === generation;
    },
    async unlock(password: string) {
      clear();
      const expected = generation;
      const id = next++;
      if (!connected) return { id, realm: "locked" as const };
      const reply = await requestReply(port, pending, {
        id,
        op: "unlock",
        password,
      });
      if (!connected || expected !== generation)
        return { id, realm: "locked" as const };
      permit = reply.permit;
      return reply;
    },
    async manage(
      operation: ManagementOperation,
      password: string,
    ): Promise<string> {
      if (!connected || !permit || pending.size >= 32)
        throw new Error("Authenticate the owner again.");
      const ticket = permit;
      const expected = generation;
      const id = next++;
      const reply = await requestReply(port, pending, {
        id,
        op: "manage",
        permit: ticket,
        password,
        operation,
      });
      if (
        !connected ||
        generation !== expected ||
        reply.realm !== "real" ||
        reply.resultJson === undefined
      )
        throw new Error("Owner management failed. Authenticate again.");
      return reply.resultJson;
    },
    lock() {
      clear();
      if (connected) {
        try {
          port.postMessage({ id: next++, op: "lock" });
        } catch {
          connected = false;
        }
      }
    },
  };
}

function requestReply(
  port: PagePort,
  pending: Map<number, (reply: SecurityReply) => void>,
  message: SecurityRequest,
): Promise<SecurityReply> {
  return new Promise((resolve) => {
    pending.set(message.id, resolve);
    try {
      port.postMessage(message);
    } catch {
      pending.delete(message.id);
      resolve({ id: message.id, realm: "locked" });
    }
  });
}
