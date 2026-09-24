/**
 * Where a person hears about things, as one serializable document (ADR 0084;
 * ADR 0140 plan step 6). The shape a `VirtualFileProvider` will store in plan
 * step 11 (ADR 0134: Settings is files): parse, serialize and every edit are
 * pure, and the Form's keys are edits to this document.
 *
 * A preference is only a preference, and the document is built so it cannot
 * be anything more:
 *   - it names channel kinds from os-domain's closed vocabulary and an order
 *     per notification class. There is no field for what it takes to approve —
 *     no assurance, no policy, no "direct approval" — and a document that
 *     tries to carry one is refused whole rather than having the key dropped;
 *   - it cannot admit a channel. The Identity API intersects it with policy,
 *     live bindings and configured adapters every time it is read
 *     (`planNotificationRoute`), so a channel policy refused finds nothing to
 *     select however it is listed here;
 *   - the inbox is the floor. `in_app` is appended by the route whether or
 *     not it is listed, and no edit here removes it from a class.
 */

import {
  type BoundaryValue,
  DEFAULT_NOTIFICATION_PREFERENCE,
  type JsonObject,
  NOTIFICATION_CHANNEL_KINDS,
  NOTIFICATION_CLASSES,
  type NotificationChannelKind,
  type NotificationClass,
  type NotificationPreference,
  isJsonObject,
} from "@opensesame/os-domain";

export const ROUTING_DOCUMENT_VERSION = 1;

export type RoutingByClass = {
  [cls in NotificationClass]?: NotificationPreference;
};

export type NotificationRoutingDocument = {
  version: typeof ROUTING_DOCUMENT_VERSION;
  byClass: RoutingByClass;
};

export type RoutingParse =
  | { ok: true; document: NotificationRoutingDocument }
  | { ok: false; errors: string[] };

/**
 * Keys a hand-edited file might reach for to widen what a preference means.
 * Named so the refusal can say why, rather than "unknown key".
 */
const AUTHORITY_KEYS = [
  "allowedChannels",
  "directApprovalChannels",
  "directDenialChannels",
  "requiredAssurance",
  "requireTransactionBoundActivation",
  "requireComparison",
  "maximumApprovalAgeSeconds",
  "maximumNotificationConfidentiality",
  "riskClass",
  "policy",
];

const AUTHORITY_REFUSAL =
  "cannot set what it takes to approve — a preference only orders where you are told";

export function emptyRoutingDocument(): NotificationRoutingDocument {
  return { version: ROUTING_DOCUMENT_VERSION, byClass: {} };
}

function channelKind(value: BoundaryValue): NotificationChannelKind | null {
  return NOTIFICATION_CHANNEL_KINDS.find((kind) => kind === value) ?? null;
}

function notificationClass(value: string): NotificationClass | null {
  return NOTIFICATION_CLASSES.find((cls) => cls === value) ?? null;
}

function authorityKeys(value: JsonObject, where: string): string[] {
  return Object.keys(value)
    .filter((key) => AUTHORITY_KEYS.includes(key))
    .map((key) => `${where}.${key} ${AUTHORITY_REFUSAL}.`);
}

function parsePreference(
  value: BoundaryValue,
  where: string,
): { preference: NotificationPreference | null; errors: string[] } {
  if (!isJsonObject(value)) {
    return { preference: null, errors: [`${where} must be an object.`] };
  }
  const errors = authorityKeys(value, where);
  const channels: NotificationChannelKind[] = [];
  const listed = Array.isArray(value.channels) ? value.channels : null;
  if (listed === null) errors.push(`${where}.channels must be a list.`);
  for (const entry of listed ?? []) {
    const kind = channelKind(entry);
    if (kind === null) {
      errors.push(`${where}.channels names an unknown channel.`);
    } else if (channels.includes(kind)) {
      errors.push(`${where}.channels lists ${kind} twice.`);
    } else {
      channels.push(kind);
    }
  }
  const fanOut = value.fanOut ?? false;
  if (fanOut !== true && fanOut !== false) {
    errors.push(`${where}.fanOut must be true or false.`);
  }
  const preference = { channels, fanOut: fanOut === true };
  return { preference: errors.length === 0 ? preference : null, errors };
}

/** Read a byClass map (a document's, or the Identity API's). */
function parseByClass(value: BoundaryValue): {
  byClass: RoutingByClass;
  errors: string[];
} {
  const byClass: RoutingByClass = {};
  if (!isJsonObject(value)) {
    return { byClass, errors: ["byClass must be an object."] };
  }
  const errors = authorityKeys(value, "byClass");
  for (const [key, entry] of Object.entries(value)) {
    if (AUTHORITY_KEYS.includes(key)) continue;
    const cls = notificationClass(key);
    if (cls === null) {
      errors.push("byClass names an unknown notification class.");
      continue;
    }
    const read = parsePreference(entry, `byClass.${cls}`);
    errors.push(...read.errors);
    if (read.preference) byClass[cls] = read.preference;
  }
  return { byClass, errors };
}

/**
 * Parse a document. Refused whole on any error: a file half-applied is a
 * preference nobody wrote.
 */
export function parseRoutingDocument(value: BoundaryValue): RoutingParse {
  if (!isJsonObject(value)) {
    return { ok: false, errors: ["The document must be a JSON object."] };
  }
  const errors = authorityKeys(value, "document");
  if (value.version !== ROUTING_DOCUMENT_VERSION) {
    errors.push(`version must be ${ROUTING_DOCUMENT_VERSION}.`);
  }
  const read = parseByClass(value.byClass ?? {});
  errors.push(...read.errors);
  return errors.length > 0
    ? { ok: false, errors }
    : {
        ok: true,
        document: { version: ROUTING_DOCUMENT_VERSION, byClass: read.byClass },
      };
}

/** The Identity API's `byClass`, as a document; `null` when unreadable. */
export function routingFromWire(
  byClass: BoundaryValue,
): NotificationRoutingDocument | null {
  const read = parseByClass(byClass ?? {});
  return read.errors.length > 0
    ? null
    : { version: ROUTING_DOCUMENT_VERSION, byClass: read.byClass };
}

/** The body `PUT /v1/notification-preferences` takes. */
export function routingToWire(document: NotificationRoutingDocument): {
  byClass: RoutingByClass;
} {
  return { byClass: document.byClass };
}

/** Canonical text: classes in os-domain's order, two-space JSON, one newline. */
export function serializeRoutingDocument(
  document: NotificationRoutingDocument,
): string {
  const byClass: RoutingByClass = {};
  for (const cls of NOTIFICATION_CLASSES) {
    const preference = document.byClass[cls];
    if (preference) {
      byClass[cls] = {
        channels: [...preference.channels],
        fanOut: preference.fanOut,
      };
    }
  }
  const text = JSON.stringify({ version: document.version, byClass }, null, 2);
  return `${text}\n`;
}

/** A class nobody configured still routes to the inbox. */
export function preferenceFor(
  document: NotificationRoutingDocument,
  cls: NotificationClass,
): NotificationPreference {
  const preference = document.byClass[cls] ?? DEFAULT_NOTIFICATION_PREFERENCE;
  return { channels: [...preference.channels], fanOut: preference.fanOut };
}

function withPreference(
  document: NotificationRoutingDocument,
  cls: NotificationClass,
  preference: NotificationPreference,
): NotificationRoutingDocument {
  return {
    version: document.version,
    byClass: { ...document.byClass, [cls]: preference },
  };
}

/**
 * Move one entry earlier (-1) or later (1). The same document back when
 * nothing moved, so a caller can skip a needless save.
 */
export function moveChannel(
  document: NotificationRoutingDocument,
  cls: NotificationClass,
  index: number,
  direction: -1 | 1,
): NotificationRoutingDocument {
  const current = preferenceFor(document, cls);
  const channels = [...current.channels];
  const a = channels[index];
  const b = channels[index + direction];
  if (a === undefined || b === undefined) return document;
  channels[index] = b;
  channels[index + direction] = a;
  return withPreference(document, cls, { ...current, channels });
}

/** Add a channel at the end of a class's order; unchanged if listed. */
export function addChannel(
  document: NotificationRoutingDocument,
  cls: NotificationClass,
  kind: NotificationChannelKind,
): NotificationRoutingDocument {
  const current = preferenceFor(document, cls);
  if (current.channels.includes(kind)) return document;
  const channels = [...current.channels, kind];
  return withPreference(document, cls, { ...current, channels });
}

/** Remove a channel from a class's order. The inbox cannot be removed. */
export function removeChannel(
  document: NotificationRoutingDocument,
  cls: NotificationClass,
  kind: NotificationChannelKind,
): NotificationRoutingDocument {
  const current = preferenceFor(document, cls);
  if (kind === "in_app" || !current.channels.includes(kind)) return document;
  const channels = current.channels.filter((entry) => entry !== kind);
  return withPreference(document, cls, { ...current, channels });
}

export function setFanOut(
  document: NotificationRoutingDocument,
  cls: NotificationClass,
  fanOut: boolean,
): NotificationRoutingDocument {
  const current = preferenceFor(document, cls);
  if (current.fanOut === fanOut) return document;
  return withPreference(document, cls, { ...current, fanOut });
}
