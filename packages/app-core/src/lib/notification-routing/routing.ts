/**
 * Settings › Notifications as a model (ADR 0084; ADR 0140 plan step 6): what
 * `apps/ceremonies/src/pages/NotificationSettings.tsx` did in its component,
 * over the document (`document.ts`), the channel words (`channels.ts`) and
 * the Identity API (`transport.ts`). Plan step 11 draws it and backs the
 * document with a `VirtualFileProvider`.
 *
 * Two habits carry the screen's honesty, and both live here rather than in
 * whatever draws it:
 *   - an edit that did not save is not shown as saved. The document is
 *     replaced only after the Identity API accepted it; a refusal leaves the
 *     last saved document in place and says why;
 *   - the route is the server's. After every change the effective route is
 *     read back, exclusions and all, rather than computed here — a screen that
 *     shows only what a person asked for, and not what the server discarded,
 *     is the polite kind of lie.
 *
 * And one refusal (`policy.ts`): an edit that would add a channel the
 * server's route says policy refused for that class is refused before
 * anything is sent. A preference reorders and narrows; it never admits.
 */

import {
  NOTIFICATION_CLASSES,
  type NotificationChannelKind,
  type NotificationClass,
} from "@opensesame/os-domain";
import type { BindingRow, ChannelRow, EffectiveRoute } from "./channels.js";
import {
  type NotificationRoutingDocument,
  addChannel,
  emptyRoutingDocument,
  moveChannel,
  preferenceFor,
  removeChannel,
  setFanOut,
} from "./document.js";
import {
  type RoutesByClass,
  admitsRefusedChannel,
  policyAllows,
} from "./policy.js";
import {
  type BegunBinding,
  type RoutingClient,
  RoutingError,
  type RoutingTransport,
  identityRoutingTransport,
  routingClient,
} from "./transport.js";

export type RoutingState = {
  channels: ChannelRow[];
  bindings: BindingRow[];
  /** The last document the Identity API accepted (or returned). */
  document: NotificationRoutingDocument;
  routeClass: NotificationClass;
  route: EffectiveRoute | null;
  /** Every class's route, read after each change: what policy allows. */
  routes: RoutesByClass;
};

/** The state after a step, and what to tell the person about it. */
export type RoutingStep = {
  state: RoutingState;
  /** A change that landed, in words. */
  status: string | null;
  /** A refusal, in words. */
  error: string | null;
  /** A binding just begun: its one-time value, for this step only. */
  begun?: BegunBinding;
};

export type RoutingEdit =
  | { kind: "move"; cls: NotificationClass; index: number; direction: -1 | 1 }
  | { kind: "add"; cls: NotificationClass; channel: NotificationChannelKind }
  | { kind: "remove"; cls: NotificationClass; channel: NotificationChannelKind }
  | { kind: "fanOut"; cls: NotificationClass; fanOut: boolean };

function wordsOf(error: Error | null): string {
  return error instanceof RoutingError
    ? error.message
    : "That did not go through. Nothing changed.";
}

function applied(
  document: NotificationRoutingDocument,
  edit: RoutingEdit,
): { next: NotificationRoutingDocument; note: string } {
  if (edit.kind === "move") {
    const next = moveChannel(document, edit.cls, edit.index, edit.direction);
    return { next, note: "Order saved." };
  }
  if (edit.kind === "add") {
    return {
      next: addChannel(document, edit.cls, edit.channel),
      note: "Added to your order.",
    };
  }
  if (edit.kind === "remove") {
    return {
      next: removeChannel(document, edit.cls, edit.channel),
      note: "Removed from your order.",
    };
  }
  const who = edit.cls === "security_event" ? "Security events" : "These";
  return {
    next: setFanOut(document, edit.cls, edit.fanOut),
    note: edit.fanOut
      ? `${who} will go to every destination that works.`
      : `${who} will stop at the first destination that works.`,
  };
}

/**
 * The channels a class may still add: configured here, able to notify, not
 * already listed, and not refused by policy for this class. Offering a
 * channel with no adapter would be offering a switch that does nothing; one
 * policy refused, a preference that could never be honoured.
 */
export function addableChannels(
  state: RoutingState,
  cls: NotificationClass,
): ChannelRow[] {
  const listed = preferenceFor(state.document, cls).channels;
  return state.channels.filter(
    (row) =>
      row.configured &&
      row.capabilities.canNotify &&
      !listed.includes(row.kind) &&
      policyAllows(state.routes[cls], row.kind) !== false,
  );
}

/** The channels a person may connect a destination for here. */
export function connectableChannels(state: RoutingState): ChannelRow[] {
  return state.channels.filter((row) => row.bindable && row.configured);
}

/**
 * The state's reads and its one write: every route read back after a change,
 * and the save that is refused before it is sent when it admits a channel
 * policy refused.
 */
function routingCore(client: RoutingClient, state: RoutingState) {
  const snapshot = (): RoutingState => ({ ...state });
  const done = (status: string | null, error: string | null): RoutingStep => ({
    state: snapshot(),
    status,
    error,
  });

  /** Every class's route; the shown one is the selected class's. */
  async function readRoute(): Promise<string | null> {
    try {
      const routes: RoutesByClass = {};
      for (const cls of NOTIFICATION_CLASSES) {
        routes[cls] = await client.effectiveRoute(cls);
      }
      state.routes = routes;
      state.route = routes[state.routeClass] ?? null;
      return null;
    } catch (error) {
      state.routes = {};
      state.route = null;
      return wordsOf(error instanceof Error ? error : null);
    }
  }

  /** Save a whole document, refused first if it admits what policy refused. */
  async function save(
    next: NotificationRoutingDocument,
    note: string,
  ): Promise<RoutingStep> {
    const refusal = admitsRefusedChannel(state.document, next, state.routes);
    if (refusal !== null) return done(null, refusal);
    try {
      await client.savePreferences(next);
    } catch (error) {
      return done(null, wordsOf(error instanceof Error ? error : null));
    }
    state.document = next;
    return done(note, await readRoute());
  }

  return { snapshot, done, readRoute, save };
}

export function createNotificationRouting(
  transport: RoutingTransport = identityRoutingTransport,
) {
  const client: RoutingClient = routingClient(transport);
  const state: RoutingState = {
    channels: [],
    bindings: [],
    document: emptyRoutingDocument(),
    routeClass: "authorization_request",
    route: null,
    routes: {},
  };
  const { snapshot, done, readRoute, save } = routingCore(client, state);

  return {
    state: snapshot,
    async load(): Promise<RoutingStep> {
      // Preferences belong to an account: without one there is nothing to
      // read, and an empty screen would read as "nothing configured".
      if (!transport.signedIn()) {
        return done(null, new RoutingError(401, "unauthorized").message);
      }
      try {
        state.channels = await client.channels();
        state.bindings = await client.bindings();
        state.document = await client.preferences();
      } catch (error) {
        return done(null, wordsOf(error instanceof Error ? error : null));
      }
      return done(null, await readRoute());
    },
    async showRoute(cls: NotificationClass): Promise<RoutingStep> {
      if (!NOTIFICATION_CLASSES.includes(cls)) return done(null, null);
      state.routeClass = cls;
      state.route = state.routes[cls] ?? null;
      return done(null, state.route ? null : await readRoute());
    },
    /** Apply one edit; the document changes only once the save landed. */
    async edit(edit: RoutingEdit): Promise<RoutingStep> {
      const { next, note } = applied(state.document, edit);
      if (next === state.document) return done(null, null);
      return save(next, note);
    },
    /**
     * Replace the whole document — a write to the settings file. The same
     * refusal and the same save as an edit: the file is not a second road.
     */
    async replace(next: NotificationRoutingDocument): Promise<RoutingStep> {
      return save(next, "Saved.");
    },
    async bind(kind: NotificationChannelKind): Promise<RoutingStep> {
      let begun: BegunBinding;
      try {
        begun = await client.beginBinding(kind, state.channels);
        state.bindings = await client.bindings();
      } catch (error) {
        return done(null, wordsOf(error instanceof Error ? error : null));
      }
      return { ...done(begun.words, null), begun };
    },
    async unbind(id: string): Promise<RoutingStep> {
      const binding = state.bindings.find((row) => row.id === id);
      if (!binding) return done(null, null);
      let words: string;
      try {
        words = await client.revokeBinding(binding);
        state.bindings = await client.bindings();
      } catch (error) {
        return done(null, wordsOf(error instanceof Error ? error : null));
      }
      return done(words, await readRoute());
    },
  };
}

export type NotificationRouting = ReturnType<typeof createNotificationRouting>;
