/**
 * Settings › Notifications as files (ADR 0134; ADR 0140 D9). The category
 * keeps three, all under `settings/notifications/`:
 *
 * | File | Stored as | Written by |
 * |---|---|---|
 * | `routing.json` | the Identity API's preferences (`PUT /v1/notification-preferences`) | the Form's order, add, remove and fan-out keys, or the file viewer |
 * | `channels.json` | the deployment's channel listing, with os-domain's capability record | nothing — read-only |
 * | `bindings.json` | this account's destinations, without their provider subject | nothing — connecting or disconnecting one is a ceremony (ADR 0084 §2) |
 *
 * The Form and the viewer write `routing.json` through one road
 * (`NotificationRouting.replace` / `.edit`), so the same refusals meet both:
 * the document parser refuses any key that would say what it takes to
 * approve (`document.ts`), and a document that adds a channel policy refused
 * for a class is refused before it is sent (`policy.ts`).
 *
 * Nothing here holds a copy: every read is serialized from the routing
 * state the Form is drawn from, and a file is listed only once that state
 * has been read from the Identity API.
 */

import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import {
  type NotificationRoutingDocument,
  parseRoutingDocument,
  serializeRoutingDocument,
} from "../../lib/notification-routing/document.js";
import { admitsRefusedChannel } from "../../lib/notification-routing/policy.js";
import type {
  RoutingState,
  RoutingStep,
} from "../../lib/notification-routing/routing.js";
import type {
  FileCheck,
  FileOutcome,
  VirtualFile,
  VirtualFileProvider,
} from "./virtual-files.js";

export const NOTIFICATIONS_DIRECTORY = "settings/notifications";
export const ROUTING_FILE = `${NOTIFICATIONS_DIRECTORY}/routing.json`;
export const CHANNELS_FILE = `${NOTIFICATIONS_DIRECTORY}/channels.json`;
export const BINDINGS_FILE = `${NOTIFICATIONS_DIRECTORY}/bindings.json`;

/** What the files are drawn from: the routing state and its one write. */
export type RoutingFilesSession = {
  /** The state as last read, or null before it was read. */
  current(): RoutingState | null;
  replace(document: NotificationRoutingDocument): Promise<RoutingStep>;
};

const FILES: readonly VirtualFile[] = [
  { path: ROUTING_FILE, language: "json", readOnly: false, removable: false },
  {
    path: CHANNELS_FILE,
    language: "json",
    readOnly: true,
    removable: false,
    readOnlyLabel: "The deployment's channels; read-only",
  },
  {
    path: BINDINGS_FILE,
    language: "json",
    readOnly: true,
    removable: false,
    readOnlyLabel:
      "Changed by connecting or disconnecting a destination; read-only",
  },
];

/** A row of `bindings.json`: there is no field for a provider subject. */
type BindingFileEntry = {
  id: string;
  kind: string;
  label?: string;
  state: string;
};

/** The channel listing: kind, whether it works here, and what it can do. */
export function channelsFileText(state: RoutingState): string {
  const channels = state.channels.map((row) => ({
    kind: row.kind,
    configured: row.configured,
    interaction: row.capabilities.maximumInteractionMode,
    shows: row.capabilities.confidentiality,
    canApproveHighRisk: row.capabilities.canSatisfyPhishingResistance,
  }));
  return `${JSON.stringify({ channels }, null, 2)}\n`;
}

/** This account's destinations, by id, kind, label and state. */
export function bindingsFileText(state: RoutingState): string {
  const bindings = state.bindings.map((row) => {
    const entry: BindingFileEntry = {
      id: row.id,
      kind: row.kind,
      state: row.state,
    };
    if (row.label !== undefined) entry.label = row.label;
    return entry;
  });
  return `${JSON.stringify({ bindings }, null, 2)}\n`;
}

type Parsed =
  | { ok: true; document: NotificationRoutingDocument }
  | { ok: false; message: string };

function parseText(raw: string, state: RoutingState | null): Parsed {
  let value: BoundaryValue;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, message: "routing.json is not valid JSON." };
  }
  if (!isJsonObject(value)) {
    return { ok: false, message: "The document must be a JSON object." };
  }
  const parsed = parseRoutingDocument(value);
  if (!parsed.ok) {
    return { ok: false, message: parsed.errors[0] ?? "Refused." };
  }
  if (state === null) return { ok: true, document: parsed.document };
  const refusal = admitsRefusedChannel(
    state.document,
    parsed.document,
    state.routes,
  );
  return refusal === null
    ? { ok: true, document: parsed.document }
    : { ok: false, message: refusal };
}

const READ_ONLY = "This file is read-only.";

export function notificationRoutingFiles(
  session: RoutingFilesSession,
): VirtualFileProvider {
  return {
    list: () => (session.current() === null ? [] : FILES),
    async read(path) {
      const state = session.current();
      if (state === null) return "";
      if (path === ROUTING_FILE)
        return serializeRoutingDocument(state.document);
      if (path === CHANNELS_FILE) return channelsFileText(state);
      if (path === BINDINGS_FILE) return bindingsFileText(state);
      return "";
    },
    check(path, raw): FileCheck {
      if (path !== ROUTING_FILE) return { ok: false, message: READ_ONLY };
      const parsed = parseText(raw, session.current());
      return parsed.ok ? { ok: true } : parsed;
    },
    async write(path, raw): Promise<FileOutcome> {
      if (path !== ROUTING_FILE) return { ok: false, message: READ_ONLY };
      const parsed = parseText(raw, session.current());
      if (!parsed.ok) return parsed;
      const step = await session.replace(parsed.document);
      return step.error === null
        ? { ok: true, path }
        : { ok: false, message: step.error };
    },
    async remove() {
      return { ok: false, message: "This file cannot be removed." };
    },
  };
}
