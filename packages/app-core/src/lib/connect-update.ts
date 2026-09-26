/**
 * `PATCH /v1/connect/connectors/{id}` (ADR 0146): only what a person changed,
 * against `held` — the settings as Connect read them back — in the shapes
 * Connect's update schema accepts.
 */
import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  type ConnectorDraft,
  draftProblems,
  oauthData,
} from "./connect-create.js";

/**
 * What an update may say per method. An API-key connector's update takes
 * only its instructions and keys (`toAdd`); its service URLs and whose key
 * it is are fixed once it exists.
 */
function methodData(draft: ConnectorDraft): JsonObject | null {
  switch (draft.kind) {
    case "managed":
      return null;
    case "oauth":
      return oauthData(draft.oauth, true);
    case "mcp": {
      const data: JsonObject = {};
      if (draft.clientId.trim()) data.clientId = draft.clientId.trim();
      if (draft.clientSecret.trim()) {
        data.clientSecret = draft.clientSecret.trim();
      }
      return data;
    }
    case "api-key": {
      const data: JsonObject = {};
      if (draft.instructions.trim()) {
        data.instructions = draft.instructions.trim().slice(0, 4000);
      }
      if (draft.subject === "app" && draft.key.trim()) {
        data.toAdd = [{ value: draft.key.trim() }];
      }
      return data;
    }
  }
}

/** Secrets Connect never reads back: sent only when a person typed one. */
const WRITE_ONLY = new Set(["clientSecret", "toAdd"]);

/**
 * How Connect's update schema clears a field: an empty string for a string
 * (and for a `serverConfig` override), an empty object for the extra
 * authorization params. Never `null`, which no field accepts.
 */
function cleared(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return [];
  if (isJsonObject(value)) return {};
  return isString(value) ? "" : undefined;
}

/**
 * `serverConfig` carries overrides of the server's discovered metadata; an
 * override the person removed is sent as an empty value, which is how the
 * schema says "stop overriding".
 */
function serverConfigPatch(
  after: JsonValue | undefined,
  before: JsonValue | undefined,
): JsonValue | undefined {
  if (!isJsonObject(after) || !isJsonObject(before)) return after;
  const patch: JsonObject = { ...after };
  for (const [key, value] of Object.entries(before)) {
    if (key in after) continue;
    const empty = cleared(value);
    if (empty !== undefined) patch[key] = empty;
  }
  return patch;
}

/** The fields of `after` that differ from `before`, removals cleared. */
function mergePatch(after: JsonObject, before: JsonObject | null): JsonObject {
  const patch: JsonObject = {};
  for (const [key, value] of Object.entries(after)) {
    if (key === "clientId" && value === "") continue;
    const same =
      before !== null &&
      !WRITE_ONLY.has(key) &&
      JSON.stringify(value) === JSON.stringify(before[key]);
    if (same) continue;
    patch[key] =
      key === "serverConfig" ? serverConfigPatch(value, before?.[key]) : value;
  }
  for (const [key, value] of Object.entries(before ?? {})) {
    if (key in after || WRITE_ONLY.has(key) || key === "clientId") continue;
    const empty = cleared(value);
    if (empty !== undefined) patch[key] = empty;
  }
  return patch;
}

/**
 * The update body. Connect never returns a secret and may leave out what a
 * preset set, so a field the person did not touch is never sent: a rename
 * cannot wipe the client, PKCE or refresh settings. A blank client ID is
 * never sent.
 */
export function updateBody(
  draft: ConnectorDraft,
  held?: ConnectorDraft,
): JsonObject {
  const body: JsonObject = {};
  if (draft.name.trim() !== held?.name.trim()) body.name = draft.name.trim();
  if (draft.uid.trim() && draft.uid.trim() !== held?.uid.trim()) {
    body.uid = draft.uid.trim();
  }
  const after = methodData(draft);
  if (!after) return body;
  const before = held?.kind === draft.kind ? methodData(held) : null;
  const data = mergePatch(after, before);
  if (Object.keys(data).length > 0) body.data = data;
  return body;
}

/** An API-key connector's service and subject, which no update can change. */
function fixedFieldProblems(
  draft: ConnectorDraft,
  held: ConnectorDraft,
): string[] {
  if (draft.kind !== "api-key" || held.kind !== "api-key") return [];
  const same =
    draft.subject === held.subject &&
    JSON.stringify(draft.serviceUrls) === JSON.stringify(held.serviceUrls);
  return same
    ? []
    : [
        "The API and whose key are set when the connector is created; create another to change them.",
      ];
}

/**
 * Why an edit cannot be saved: the problems it introduces. What was already
 * true of the stored connector (a secret the page never holds, a preset field
 * Connect did not echo) is not the edit's to fix.
 */
export function updateProblems(
  draft: ConnectorDraft,
  held: ConnectorDraft,
): string[] {
  const before = new Set(draftProblems(held));
  return [
    ...draftProblems(draft).filter((problem) => !before.has(problem)),
    ...fixedFieldProblems(draft, held),
  ];
}
