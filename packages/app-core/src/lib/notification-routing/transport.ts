/**
 * The notification-routing routes of the Identity API (ADR 0084): the channel
 * listing, a person's destinations, their preferences and the effective
 * route. The transport is injected; Pages passes `identityFetch`, which
 * attaches the session itself, so nothing here handles a credential.
 *
 * Refusals are worded by the body's error code first and the status only when
 * it names none — the ceremonies screen read these routes' refusals with the
 * approval vocabulary, so a `step_up_required` 403 on connecting a
 * destination told a person the request "is not addressed to you".
 */

import { channelName } from "@opensesame/ceremony-kit";
import {
  type BoundaryValue,
  type JsonObject,
  type NotificationChannelKind,
  type NotificationClass,
  channelCapabilities,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { currentSession, identityFetch } from "../identity.js";
import {
  type BindingRow,
  type ChannelRow,
  type EffectiveRoute,
  readBindings,
  readChannels,
  readEffectiveRoute,
} from "./channels.js";
import {
  type NotificationRoutingDocument,
  routingFromWire,
  routingToWire,
} from "./document.js";

export interface RoutingTransport {
  /** An Identity API call; `path` is relative to the configured base. */
  fetch(path: string, init: RequestInit): Promise<Response>;
  /** Whether an Identity session is held: preferences belong to one. */
  signedIn(): boolean;
}

export const identityRoutingTransport: RoutingTransport = {
  fetch: (path, init) => identityFetch(path, init),
  signedIn: () => currentSession() !== null,
};

const WORDS: Readonly<Record<string, string>> = {
  unauthorized: "Sign in to choose where you hear about requests.",
  step_up_required:
    "Connecting or disconnecting a destination needs a recent sign-in. Sign in again, then try once more.",
  channel_needs_no_binding:
    "This channel has nothing to connect — it reaches you without a destination of its own.",
  adapter_unavailable:
    "This deployment has no working adapter for that channel, so there is nothing to connect.",
  binding_limit:
    "You have connected as many destinations as this deployment allows. Disconnect one first.",
  destination_already_bound:
    "That destination is already connected to another account.",
  not_found: "That destination is already gone. Nothing changed.",
  invalid_request: "That was refused as malformed. Nothing changed.",
  unreachable:
    "The sign-in service could not be reached. Nothing changed; try again.",
};

const BY_STATUS: Readonly<Record<number, string>> = {
  0: "unreachable",
  400: "invalid_request",
  401: "unauthorized",
  404: "not_found",
};

/** A refused routing call, worded; `declared` is the body's code, a key only. */
export class RoutingError extends Error {
  readonly status: number;
  readonly declared: string;
  constructor(status: number, declared: string) {
    const code = Object.hasOwn(WORDS, declared)
      ? declared
      : (BY_STATUS[status] ?? "");
    super(
      (Object.hasOwn(WORDS, code) ? WORDS[code] : undefined) ??
        `That did not go through (${status}). Nothing changed.`,
    );
    this.name = "RoutingError";
    this.status = status;
    this.declared = declared;
  }
}

/** A binding begun: carried to the provider once, never stored here. */
export type BegunBinding = {
  challengeId: string;
  /**
   * The one-time value the person carries to the provider. The server keeps
   * only its digest and returns it once; a surface shows it once and drops it.
   */
  nonce: string;
  expiresAt: string;
  /** Only an `https:` address: nothing else is ever opened. */
  authorizeUrl?: string;
  words: string;
};

function httpsOnly(value: BoundaryValue): string | undefined {
  if (!isString(value)) return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function routingClient(
  transport: RoutingTransport = identityRoutingTransport,
) {
  async function call(path: string, init: RequestInit): Promise<JsonObject> {
    let res: Response;
    try {
      res = await transport.fetch(path, {
        ...init,
        headers: { accept: "application/json", ...(init.headers ?? {}) },
      });
    } catch {
      throw new RoutingError(0, "");
    }
    const body: BoundaryValue =
      res.status === 204 ? null : await res.json().catch(() => null);
    const read = isJsonObject(body) ? body : {};
    if (res.ok) return read;
    throw new RoutingError(res.status, isString(read.error) ? read.error : "");
  }
  const put = (body: string): RequestInit => ({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body,
  });

  return {
    async channels(): Promise<ChannelRow[]> {
      return readChannels(
        await call("/v1/notification-channels", { method: "GET" }),
      );
    },
    async bindings(): Promise<BindingRow[]> {
      return readBindings(
        await call("/v1/notification-channels/bindings", { method: "GET" }),
      );
    },
    async preferences(): Promise<NotificationRoutingDocument> {
      const body = await call("/v1/notification-preferences", {
        method: "GET",
      });
      const document = routingFromWire(body.byClass);
      if (!document) throw new RoutingError(200, "invalid_request");
      return document;
    },
    async savePreferences(
      document: NotificationRoutingDocument,
    ): Promise<void> {
      await call(
        "/v1/notification-preferences",
        put(JSON.stringify(routingToWire(document))),
      );
    },
    async effectiveRoute(cls: NotificationClass): Promise<EffectiveRoute> {
      const query = new URLSearchParams({ class: cls });
      return readEffectiveRoute(
        await call(`/v1/notification-preferences/effective?${query}`, {
          method: "GET",
        }),
      );
    },
    /**
     * Begin connecting a destination. A channel with no provider subject to
     * bind, or no adapter here, is refused before any call.
     */
    async beginBinding(
      kind: NotificationChannelKind,
      catalogue: readonly ChannelRow[],
      displayLabel = channelName(kind),
    ): Promise<BegunBinding> {
      if (!channelCapabilities(kind).bindsExternalIdentity) {
        throw new RoutingError(422, "channel_needs_no_binding");
      }
      if (!catalogue.some((row) => row.kind === kind && row.configured)) {
        throw new RoutingError(422, "adapter_unavailable");
      }
      const label = displayLabel.trim();
      const body = await call("/v1/notification-channels/bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          ...(label ? { displayLabel: label } : {}),
        }),
      });
      if (!isString(body.challengeId) || !isString(body.nonce)) {
        throw new RoutingError(200, "invalid_request");
      }
      const authorizeUrl = httpsOnly(body.authorizeUrl);
      const name = channelName(kind);
      return {
        challengeId: body.challengeId,
        nonce: body.nonce,
        expiresAt: isString(body.expiresAt) ? body.expiresAt : "",
        ...(authorizeUrl ? { authorizeUrl } : {}),
        words: authorizeUrl
          ? `Finish connecting ${name} where it opens. Until you do, nothing is delivered there.`
          : `${name} is waiting to be confirmed from the other side. Until that happens, nothing is delivered there.`,
      };
    },
    async revokeBinding(binding: BindingRow): Promise<string> {
      await call(
        `/v1/notification-channels/bindings/${encodeURIComponent(binding.id)}`,
        { method: "DELETE" },
      );
      return `Disconnected. Nothing else will be delivered to that ${binding.name} destination.`;
    },
  };
}

export type RoutingClient = ReturnType<typeof routingClient>;
