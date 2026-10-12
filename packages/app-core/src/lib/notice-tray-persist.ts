/**
 * Tray notice history that survives reload (ADR 0163): status outcomes only,
 * sealed at rest, no bearer fields. Ceremony prompts with claim tokens stay
 * in memory for the tab.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  readString,
} from "@opensesame/os-domain";
import { maybeLocalStore } from "../ports.js";
import { atRestReady } from "./at-rest/key.js";
import type { Notice } from "./notices.js";
import {
  installNoticePersistence,
  restorePersistedTrayNotices,
} from "./notices.js";

const STORAGE_KEY = "opensesame.tray-history";
const MAX_HISTORY = 48;

export type PersistedTrayNotice = Pick<
  Notice,
  | "id"
  | "kind"
  | "tone"
  | "title"
  | "body"
  | "ceremony"
  | "ceremonyLabel"
  | "retryLabel"
  | "open"
  | "createdAt"
>;

function statusCore(
  value: JsonObject,
): Pick<
  PersistedTrayNotice,
  "id" | "kind" | "title" | "body" | "createdAt"
> | null {
  const id = readString(value.id);
  const title = readString(value.title);
  const body = readString(value.body);
  const createdAt = readString(value.createdAt);
  if (
    readString(value.kind) !== "status" ||
    !id ||
    !title ||
    !body ||
    !createdAt
  ) {
    return null;
  }
  return { id, kind: "status", title, body, createdAt };
}

function optionalOpen(value: BoundaryValue): Notice["open"] | undefined {
  if (!isJsonObject(value)) return undefined;
  const to = readString(value.to);
  const label = readString(value.label);
  if (!to || !label) return undefined;
  return { to, label };
}

function withOptionals(
  value: JsonObject,
  entry: PersistedTrayNotice,
): PersistedTrayNotice {
  const tone = readString(value.tone);
  if (tone === "info" || tone === "warn" || tone === "err") entry.tone = tone;
  const ceremony = readString(value.ceremony);
  if (ceremony === "identity" || ceremony === "keys") entry.ceremony = ceremony;
  const ceremonyLabel = readString(value.ceremonyLabel);
  if (ceremonyLabel) entry.ceremonyLabel = ceremonyLabel;
  const retryLabel = readString(value.retryLabel);
  if (retryLabel) entry.retryLabel = retryLabel;
  const open = optionalOpen(value.open);
  if (open) entry.open = open;
  return entry;
}

function parseEntry(value: BoundaryValue): PersistedTrayNotice | null {
  if (!isJsonObject(value)) return null;
  const core = statusCore(value);
  if (!core) return null;
  return withOptionals(value, core);
}

function persistable(notice: Notice): PersistedTrayNotice | null {
  if (notice.kind !== "status") return null;
  if (notice.claimToken || notice.userCode) return null;
  return {
    id: notice.id,
    kind: "status",
    tone: notice.tone,
    title: notice.title,
    body: notice.body,
    ceremony: notice.ceremony,
    ceremonyLabel: notice.ceremonyLabel,
    retryLabel: notice.retryLabel,
    open: notice.open,
    createdAt: notice.createdAt,
  };
}

function readRaw(): PersistedTrayNotice[] {
  const store = maybeLocalStore();
  if (!store) return [];
  const raw = store.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    // SAFETY: sealed tray history is JSON we wrote; each row is validated in parseEntry.
    const parsed = JSON.parse(raw) as BoundaryValue;
    if (!Array.isArray(parsed)) return [];
    const kept: PersistedTrayNotice[] = [];
    for (const entry of parsed) {
      const row = parseEntry(entry);
      if (row) kept.push(row);
    }
    return kept;
  } catch {
    return [];
  }
}

function writeRaw(items: PersistedTrayNotice[]): void {
  const store = maybeLocalStore();
  if (!store) return;
  if (items.length === 0) {
    store.removeItem(STORAGE_KEY);
    return;
  }
  store.setItem(STORAGE_KEY, JSON.stringify(items.slice(-MAX_HISTORY)));
}

function mergePersisted(items: PersistedTrayNotice[]): Notice[] {
  return items.map((entry) => ({
    ...entry,
    kind: "status",
    tone: entry.tone ?? "err",
  }));
}

export function installTrayNoticePersistence(): void {
  installNoticePersistence((live) => {
    const persisted = live
      .map((notice) => persistable(notice))
      .filter((notice): notice is PersistedTrayNotice => notice !== null);
    writeRaw(persisted);
  });
}

export async function restoreTrayNoticeHistory(): Promise<void> {
  await atRestReady();
  const persisted = readRaw();
  if (persisted.length === 0) return;
  restorePersistedTrayNotices(mergePersisted(persisted));
}
