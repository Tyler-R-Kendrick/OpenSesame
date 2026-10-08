import type { SecurityPort } from "@opensesame/app-core/browser/security/runtime.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { expect } from "vitest";
import type { BrowserSender } from "./browser-ports";
import { answerArm } from "./guard-runtime";
import { armMessage, valueReply } from "./wire";

export const OWN = "abcdefghijklmnopabcdefghijklmnop";
export const OWN_BASE = `chrome-extension://${OWN}/`;
export type MessageListener = (
  request: BoundaryValue,
  sender: BrowserSender,
  sendResponse: (reply: BoundaryValue) => void,
) => true | undefined;
interface BrowserEvent<T> {
  addListener(listener: (value: T) => void): void;
  emit(value: T): void;
}
interface ApiState {
  local: Map<string, BoundaryValue>;
  session: Map<string, BoundaryValue>;
  permissions: Set<string>;
  registrations: Map<string, { id: string; matches: string[] }>;
  permissionRemoved: BrowserEvent<string>;
  toolbar: BrowserEvent<string>;
  onConnect: BrowserEvent<SecurityPort>;
  onStartup: BrowserEvent<void>;
  onRemoved: BrowserEvent<void>;
  onCommand: BrowserEvent<string>;
  addMessage: (listener: MessageListener) => void;
  ask(request: BoundaryValue, sender?: BrowserSender): Promise<BoundaryValue>;
  content(): BrowserSender;
  observed: { nonce: string; reply: BoundaryValue }[];
}
function storageArea(rows: Map<string, BoundaryValue>) {
  return {
    get: async (key: string) => ({ [key]: rows.get(key) }),
    set: async (values: Record<string, BoundaryValue>) => {
      for (const [key, value] of Object.entries(values)) rows.set(key, value);
    },
  };
}
function permissionApis(state: ApiState) {
  return {
    onRemoved: state.onRemoved,
    contains: async ({ origins }: { origins: string[] }) =>
      origins.every((p) => state.permissions.has(p)),
    remove: async ({ origins }: { origins: string[] }) => {
      for (const pattern of origins) {
        state.permissions.delete(pattern);
        state.permissionRemoved.emit(pattern);
      }
      return true;
    },
  };
}
function scriptApis(state: ApiState) {
  return {
    getRegisteredContentScripts: async () => [...state.registrations.values()],
    registerContentScripts: async (
      scripts: { id: string; matches: string[] }[],
    ) => {
      for (const script of scripts) state.registrations.set(script.id, script);
    },
    unregisterContentScripts: async ({ ids }: { ids: string[] }) => {
      for (const id of ids) state.registrations.delete(id);
    },
    executeScript: async () => [],
  };
}
function tabApis(state: ApiState) {
  return {
    query: async () => [{ id: 7, url: location.href }],
    sendMessage: async (
      tabId: number,
      message: BoundaryValue,
      options: { frameId: number },
    ) => {
      expect({ tabId, options }).toEqual({ tabId: 7, options: { frameId: 0 } });
      const arm = armMessage.parse(message);
      return answerArm(
        window,
        async (request) => {
          const reply = await state.ask(request, state.content());
          state.observed.push({ nonce: request.nonce, reply });
          return valueReply.parse(reply);
        },
        arm,
      );
    },
  };
}
export function browserApis(state: ApiState) {
  return {
    runtime: {
      id: OWN,
      getURL: (path: string) => `${OWN_BASE}${path.replace(/^\//, "")}`,
      onConnect: state.onConnect,
      onStartup: state.onStartup,
      onMessage: { addListener: state.addMessage },
    },
    commands: { onCommand: state.onCommand },
    permissions: permissionApis(state),
    storage: {
      local: storageArea(state.local),
      session: storageArea(state.session),
    },
    scripting: scriptApis(state),
    tabs: tabApis(state),
    action: {
      setBadgeText: async () => {},
      setTitle: async ({ title }: { title: string }) => {
        state.toolbar.emit(title);
      },
    },
  };
}
