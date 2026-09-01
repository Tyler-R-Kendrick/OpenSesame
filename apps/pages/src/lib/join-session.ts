/**
 * First-run join — accept an invite, or ask into a public shared session.
 *
 * An invitation is a claim session (ADR 0079 §7, ADR 0044): a bearer link and
 * an out-of-band code. Presenting the bearer does not need a user session —
 * the token is the credential being spent, and demanding an account before
 * showing the manifest would push guests to accept unseen. Completing the
 * claim, and asking to join a public session, do need a named principal.
 *
 * The Host is the server this feature reintroduces (ADR 0079). A road nobody
 * configured is not offered as a working control: with no Host the join
 * screen asks for one rather than failing a dead button.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import {
  AccessError,
  type Delegation,
  type DelegationOffer,
  claimDelegation,
} from "./access.js";
import { currentSession, hostBase, hostFetch } from "./identity.js";
import { localNetworkFetch } from "./local-network-fetch.js";
import { normalizeApiBase } from "./urls.js";

const CLAIM_TOKEN = /osc_(?:clm|dlg)_[A-Za-z0-9._-]+/;
const PRESENT_MS = 8000;

export type ParsedInvite = {
  /** Origin of the Host that minted the invite, when the paste was a URL. */
  host: string | null;
  token: string;
};

export type PublicSession = {
  id: string;
  displayName: string;
};

export type JoinRequestReceipt = {
  id: string;
  decision: string;
};

function obj(value: BoundaryValue): JsonObject {
  return value && isTypeofObject(value) ? overlapCast(value) : {};
}

function list(value: BoundaryValue): BoundaryValue[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: BoundaryValue): string[] {
  return list(value).filter((entry): entry is string => isString(entry));
}

function toOffer(value: BoundaryValue): DelegationOffer {
  const raw = obj(value);
  return {
    id: String(raw.id ?? ""),
    state: String(raw.state ?? ""),
    manifestDigest: String(raw.manifest_digest ?? ""),
    expiresAt: String(raw.expires_at ?? ""),
    items: list(raw.items).map((item) => {
      const entry = obj(item);
      return {
        id: String(entry.id ?? ""),
        connectionId: String(entry.connection_id ?? ""),
        providerId: String(entry.provider_id ?? ""),
        displayName: String(entry.display_name ?? ""),
        actions: strings(entry.actions),
        resources: strings(entry.resources),
        expiresInSeconds: 0,
        executionMode: String(entry.execution_mode ?? "broker"),
        required: Boolean(entry.required),
        dependencies: strings(entry.dependencies),
      };
    }),
  };
}

/** Pull a claim bearer and optional Host origin out of a pasted link or token. */
export function parseInviteInput(raw: string): ParsedInvite | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const fragment = new URLSearchParams(
      url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
    );
    const fromFragment = fragment.get("token");
    const fromQuery =
      url.searchParams.get("token") ?? url.searchParams.get("claim_token");
    const fromPath = trimmed.match(CLAIM_TOKEN)?.[0] ?? null;
    const token = (fromFragment || fromQuery || fromPath || "").trim();
    if (!token) return null;
    const host = normalizeApiBase(url.origin);
    return { host, token };
  } catch {
    return { host: null, token: trimmed };
  }
}

/**
 * An invite that arrived as this page's own URL — a hash bearer or a claim
 * token in the query. Absence is not an error: most first visits have none.
 * This page's origin is never the Host: a Pages deploy cannot mint a grant.
 */
export function readJoinFromLocation(
  href: string = globalThis.location?.href ?? "",
  pageOrigin: string = globalThis.location?.origin ?? "",
): ParsedInvite | null {
  if (!href) return null;
  const parsed = parseInviteInput(href);
  if (!parsed) return null;
  if (parsed.host && pageOrigin && parsed.host === pageOrigin) {
    return { host: null, token: parsed.token };
  }
  return parsed;
}

const STASH_KEY = "join.invite.v1";

/** Tab-scoped: present spends the bearer, and sign-in is a detour. */
export type JoinStash =
  | {
      kind: "invite";
      host: string;
      token: string;
      userCode: string;
      acceptedItemIds: string[];
    }
  | {
      kind: "ask";
      host: string;
      sessionId: string;
      note: string;
    };

function stashStorage(): Storage | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

export function writeJoinStash(next: JoinStash): void {
  try {
    stashStorage()?.setItem(STASH_KEY, JSON.stringify(next));
  } catch {
    // The ceremony still works in one sitting.
  }
}

export function readJoinStash(): JoinStash | null {
  try {
    const raw = stashStorage()?.getItem(STASH_KEY);
    if (!raw) return null;
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) return null;
    const kind = parsed.kind;
    const host = isString(parsed.host) ? parsed.host : "";
    if (kind === "invite") {
      if (!isString(parsed.token) || !parsed.token) return null;
      const ids = Array.isArray(parsed.acceptedItemIds)
        ? parsed.acceptedItemIds.filter(
            (id): id is string => isString(id) && id.length > 0,
          )
        : [];
      return {
        kind: "invite",
        host,
        token: parsed.token,
        userCode: isString(parsed.userCode) ? parsed.userCode : "",
        acceptedItemIds: ids,
      };
    }
    if (kind === "ask") {
      if (!isString(parsed.sessionId) || !parsed.sessionId) return null;
      return {
        kind: "ask",
        host,
        sessionId: parsed.sessionId,
        note: isString(parsed.note) ? parsed.note : "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearJoinStash(): void {
  try {
    stashStorage()?.removeItem(STASH_KEY);
  } catch {
    /* nothing stored */
  }
}

/** Finish a join that was stashed across sign-in. No-op without a session. */
export async function resumeStashedJoin(): Promise<boolean> {
  const stash = readJoinStash();
  if (!stash) return false;
  if (!joinSessionSeams.currentSession()) return false;
  if (stash.kind === "invite") {
    await joinSessionSeams.acceptInvite({
      claimToken: stash.token,
      userCode: stash.userCode,
      acceptedItemIds: stash.acceptedItemIds,
    });
  } else {
    await joinSessionSeams.askToJoin(stash.sessionId, stash.note);
  }
  clearJoinStash();
  return true;
}

async function presentInviteDefault(
  host: string,
  token: string,
): Promise<DelegationOffer> {
  const base = normalizeApiBase(host.trim());
  if (!base) {
    throw new AccessError(
      0,
      "invalid_host",
      "That is not a Host this page may call. Use https, or http on loopback.",
    );
  }
  const bearer = token.trim();
  if (!bearer) {
    throw new AccessError(
      0,
      "missing_token",
      "Paste the invite link or token.",
    );
  }
  let res: Response;
  try {
    res = await localNetworkFetch(`${base}/api/v1/delegations/present`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claim_token: bearer }),
      timeoutMs: PRESENT_MS,
    });
  } catch (error) {
    if (error instanceof Error && !(error instanceof TypeError)) throw error;
    throw new AccessError(
      0,
      "unreachable",
      `Host API unreachable at ${base}. Start the Host, or point at a running one.`,
    );
  }
  if (!res.ok) {
    const body = obj(await res.json().catch(() => null));
    const code = isString(body.error) ? body.error : "unknown_error";
    throw new AccessError(
      res.status,
      code,
      "That offer is unknown, spent, or expired — ask the owner for a fresh code.",
    );
  }
  return toOffer(obj(obj(await res.json()).offer));
}

async function acceptInviteDefault(input: {
  claimToken: string;
  userCode: string;
  acceptedItemIds: string[];
}): Promise<Delegation[]> {
  if (!joinSessionSeams.currentSession()) {
    throw new AccessError(
      401,
      "session_required",
      "Accepting wraps the grant for your account. Sign in, then accept.",
    );
  }
  return claimDelegation({
    claimToken: input.claimToken.trim(),
    userCode: input.userCode.trim(),
    acceptedItemIds: input.acceptedItemIds,
  });
}

async function askToJoinDefault(
  sessionId: string,
  note?: string,
): Promise<JoinRequestReceipt> {
  const id = sessionId.trim();
  if (!id) {
    throw new AccessError(
      0,
      "missing_session",
      "Name the session you want in.",
    );
  }
  if (!joinSessionSeams.currentSession()) {
    throw new AccessError(
      401,
      "session_required",
      "Asking to join names you. Sign in, then ask.",
    );
  }
  if (!joinSessionSeams.hostBase().trim()) {
    throw new AccessError(
      0,
      "setup_required",
      "Joining a session needs a Host. Point this app at one, then ask.",
    );
  }
  let res: Response;
  try {
    res = await hostFetch(
      `/api/v1/shared-sessions/${encodeURIComponent(id)}/join-requests`,
      {
        method: "POST",
        body: JSON.stringify(note?.trim() ? { note: note.trim() } : {}),
      },
    );
  } catch (error) {
    if (error instanceof AccessError) throw error;
    if (error instanceof Error && error.name === "HostSessionError") {
      throw new AccessError(0, "setup_required", error.message);
    }
    throw new AccessError(
      0,
      "unreachable",
      `Host API unreachable at ${joinSessionSeams.hostBase()}. Start the Host, or point at a running one.`,
    );
  }
  if (!res.ok) {
    const body = obj(await res.json().catch(() => null));
    const code = isString(body.error) ? body.error : "unknown_error";
    const detail =
      code === "join_request_pending"
        ? "You already have a request waiting."
        : code === "already_in_session"
          ? "You are already in this session."
          : code === "session_not_found"
            ? "No public session by that name."
            : "The Host refused the request.";
    throw new AccessError(res.status, code, detail);
  }
  const body = obj(await res.json());
  return {
    id: String(body.id ?? ""),
    decision: String(body.decision ?? "pending"),
  };
}

async function discoverPublicSessionsDefault(): Promise<PublicSession[]> {
  if (!joinSessionSeams.currentSession()) {
    throw new AccessError(
      401,
      "session_required",
      "Listing public sessions names you. Sign in, then look.",
    );
  }
  const res = await hostFetch("/api/v1/shared-sessions?visibility=public");
  if (!res.ok) {
    throw new AccessError(
      res.status,
      "unknown_error",
      "The Host would not list public sessions.",
    );
  }
  const body = obj(await res.json());
  return list(body.sessions).map((entry) => {
    const session = obj(entry);
    return {
      id: String(session.id ?? ""),
      displayName: String(session.display_name ?? ""),
    };
  });
}

export const joinSessionSeams = {
  presentInvite: presentInviteDefault,
  acceptInvite: acceptInviteDefault,
  askToJoin: askToJoinDefault,
  discoverPublicSessions: discoverPublicSessionsDefault,
  currentSession,
  hostBase,
};

export function presentInvite(
  host: string,
  token: string,
): Promise<DelegationOffer> {
  return joinSessionSeams.presentInvite(host, token);
}

export function acceptInvite(
  input: Parameters<typeof acceptInviteDefault>[0],
): Promise<Delegation[]> {
  return joinSessionSeams.acceptInvite(input);
}

/** Ask to join a public shared session. Needs a signed-in principal. */
export function askToJoin(
  sessionId: string,
  note?: string,
): Promise<JoinRequestReceipt> {
  return joinSessionSeams.askToJoin(sessionId, note);
}

export function discoverPublicSessions(): Promise<PublicSession[]> {
  return joinSessionSeams.discoverPublicSessions();
}
