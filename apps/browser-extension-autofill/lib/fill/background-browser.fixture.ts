import type { PageRuntime } from "@opensesame/app-core/browser/security/client.js";
import type { SecurityPort } from "@opensesame/app-core/browser/security/runtime.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  type MessageListener,
  OWN,
  OWN_BASE,
  browserApis,
} from "./background-browser-apis.fixture";
export { OWN, OWN_BASE } from "./background-browser-apis.fixture";
import { deferred } from "@opensesame/app-core/browser/security/management.fixture.js";
import type { BrowserSender } from "./browser-ports";

export const POPUP = { id: OWN, url: `${OWN_BASE}popup.html` };
export function event<T>() {
  const listeners: Array<(value: T) => void> = [];
  return {
    addListener: (listener: (value: T) => void) => {
      listeners.push(listener);
    },
    emit: (value: T) => {
      for (const listener of listeners) listener(value);
    },
  };
}
function securityWire(onConnect: ReturnType<typeof event<SecurityPort>>) {
  const connections: Array<() => void> = [];
  const waiting = new Set<Promise<void>>();
  const runtime: PageRuntime = {
    connect: ({ name }) => {
      const inbound = event<BoundaryValue>();
      const outbound = event<BoundaryValue>();
      const disconnected = event<void>();
      const acknowledgments = new Map<
        number,
        ReturnType<typeof deferred<void>>
      >();
      let closed = false;
      const port: SecurityPort = {
        name,
        sender: POPUP,
        onMessage: inbound,
        onDisconnect: disconnected,
        postMessage: (reply) => {
          acknowledgments.get(reply.id)?.finish();
          acknowledgments.delete(reply.id);
          if (!closed) outbound.emit(reply);
        },
        disconnect: () => {
          if (closed) return;
          closed = true;
          for (const done of acknowledgments.values()) done.finish();
          acknowledgments.clear();
          disconnected.emit();
        },
      };
      onConnect.emit(port);
      connections.push(port.disconnect);
      return {
        onMessage: outbound,
        onDisconnect: disconnected,
        postMessage: (message) => {
          if (closed) throw new Error("Browser test port closed");
          const done = deferred<void>();
          acknowledgments.set(message.id, done);
          waiting.add(done.promise);
          void done.promise.then(() => waiting.delete(done.promise));
          inbound.emit(message);
        },
      };
    },
  };
  return {
    runtime,
    async drain() {
      while (waiting.size) await Promise.allSettled([...waiting]);
    },
    close() {
      for (const close of connections) close();
    },
  };
}

export function backgroundBrowser() {
  const local = new Map<string, BoundaryValue>();
  const session = new Map<string, BoundaryValue>();
  const permissions = new Set<string>();
  const registrations = new Map<string, { id: string; matches: string[] }>();
  const onConnect = event<SecurityPort>();
  const onStartup = event<void>();
  const onRemoved = event<void>();
  const onCommand = event<string>();
  const listeners: MessageListener[] = [];
  const waiting = new Set<Promise<BoundaryValue>>();
  const observed: { nonce: string; reply: BoundaryValue }[] = [];
  const toolbar = event<string>();
  const permissionRemoved = event<string>();
  const security = securityWire(onConnect);
  function dispatch(request: BoundaryValue, sender: BrowserSender) {
    const done = deferred<BoundaryValue>();
    const answered = (reply: BoundaryValue) => done.finish(reply);
    const listener = listeners[0];
    if (!listener) throw new Error("Actual background listener not installed");
    const accepted = listener(request, sender, answered);
    return { accepted, reply: done.promise };
  }
  function ask(request: BoundaryValue, sender: BrowserSender = POPUP) {
    const work = dispatch(request, sender).reply;
    waiting.add(work);
    void work.then(() => waiting.delete(work));
    return work;
  }
  const content = () => ({
    id: OWN,
    tab: { id: 7 },
    frameId: 0,
    origin: location.origin,
    url: location.href,
  });
  const browser = browserApis({
    local,
    session,
    permissions,
    registrations,
    onConnect,
    onStartup,
    onRemoved,
    onCommand,
    permissionRemoved,
    toolbar,
    addMessage: (listener: MessageListener) => {
      listeners.push(listener);
    },
    ask,
    content,
    observed,
  });
  return {
    browser,
    security,
    local,
    session,
    permissions,
    registrations,
    observed,
    content,
    ask,
    dispatch,
    toolbar,
    permissionRemoved,
    onConnect,
    async drain() {
      while (waiting.size) await Promise.allSettled([...waiting]);
      await security.drain();
    },
  };
}
