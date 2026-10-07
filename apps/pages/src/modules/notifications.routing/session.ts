import {
  authorityStillCurrent,
  captureRealAuthority,
} from "@opensesame/app-core/lib/member-authority.js";
/**
 * One routing session per activation: the state Settings › Notifications'
 * Form is drawn from and its files are read from (ADR 0134). The Form's keys
 * and the file viewer's save both go through `NotificationRouting`, and each
 * change is announced once — to the Form through `subscribe`, to the file
 * viewer through `notifySettingsFilesChanged` — so neither view keeps a copy.
 *
 * Created in `activate`, never at import. It reads nothing until something
 * asks (`ensure`): the panel on mount, the file viewer when it lists. With no
 * Identity API configured, or no Identity session, it reads nothing at all.
 */

import type { NotificationRoutingDocument } from "@opensesame/app-core/lib/notification-routing/document.js";
import {
  type NotificationRouting,
  type RoutingEdit,
  type RoutingState,
  type RoutingStep,
  createNotificationRouting,
} from "@opensesame/app-core/lib/notification-routing/routing.js";
import {
  type RoutingTransport,
  identityRoutingTransport,
} from "@opensesame/app-core/lib/notification-routing/transport.js";
import { notificationRoutingFiles } from "@opensesame/app-core/sections/settings/notification-routing-files.js";
import type { VirtualFileProvider } from "@opensesame/app-core/sections/settings/virtual-files.js";
import type {
  NotificationChannelKind,
  NotificationClass,
} from "@opensesame/os-domain";
import { notifySettingsFilesChanged } from "../../sections/settings/files/revision.js";

/** What the Form shows: the last step, and whether a call is in flight. */
export type RoutingView = Readonly<{
  /** Null until the first read finished. */
  state: RoutingState | null;
  /** The last change that landed, in words. */
  status: string | null;
  /** The last refusal, in words. */
  error: string | null;
  /** A destination just begun: shown once, dropped on the next step. */
  begun: RoutingStep["begun"] | null;
  busy: boolean;
  /** Asked, and there was no Identity session to read for. */
  signedOut: boolean;
}>;

/** Who the session reads for: an Identity session on a configured API. */
export type RoutingIdentity = () => string | null;

const IDLE: RoutingView = {
  state: null,
  status: null,
  error: null,
  begun: null,
  busy: false,
  signedOut: false,
};

/** The view and who is told when it changes; nothing after `close`. */
function viewStore() {
  let view: RoutingView = IDLE;
  let closed = false;
  const listeners = new Set<() => void>();
  return {
    view: () => view,
    closed: () => closed,
    publish(next: RoutingView): void {
      if (closed) return;
      view = next;
      for (const listener of listeners) listener();
      notifySettingsFilesChanged();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close(): void {
      closed = true;
      listeners.clear();
      view = IDLE;
    },
  };
}

/** A step's outcome as the view the Form draws. */
function settled(step: RoutingStep): RoutingView {
  return {
    state: step.state,
    status: step.status,
    error: step.error,
    begun: step.begun ?? null,
    busy: false,
    signedOut: false,
  };
}

type SessionContext = {
  identity: RoutingIdentity;
  transport: RoutingTransport;
  model: NotificationRouting;
  store: ReturnType<typeof viewStore>;
  /** The identity the state was read for; a new one reads again. */
  readFor: string | null | undefined;
  epoch: number;
};

async function runRoutingOperation(
  context: SessionContext,
  work: () => Promise<RoutingStep>,
): Promise<RoutingStep | null> {
  const view = context.store.view();
  if (view.busy || context.store.closed()) return null;
  const operation = ++context.epoch;
  const originalModel = context.model;
  const who = context.identity();
  const check =
    context.transport === identityRoutingTransport
      ? captureRealAuthority()
      : () => {};
  const current = () =>
    !context.store.closed() &&
    operation === context.epoch &&
    originalModel === context.model &&
    who === context.identity() &&
    authorityStillCurrent(check);
  context.store.publish({
    ...view,
    busy: true,
    status: null,
    error: null,
    begun: null,
  });
  let step: RoutingStep;
  try {
    step = await work();
  } catch (error) {
    if (current()) throw error;
    if (
      !context.store.closed() &&
      operation === context.epoch &&
      originalModel === context.model
    )
      context.store.publish({ ...IDLE, error: "Session changed. Try again." });
    return null;
  }
  if (!current()) {
    if (
      !context.store.closed() &&
      operation === context.epoch &&
      originalModel === context.model
    )
      context.store.publish({ ...IDLE, error: "Session changed. Try again." });
    return null;
  }
  context.store.publish(settled(step));
  return step;
}

/** Read (again) when the identity changed; forget when there is none. */
function ensureRoutingSession(context: SessionContext): void {
  if (context.store.closed()) return;
  const who = context.identity();
  if (who === context.readFor) return;
  context.readFor = who;
  const operation = ++context.epoch;
  context.model = createNotificationRouting(context.transport);
  if (who === null) {
    context.store.publish({ ...IDLE, signedOut: true });
    return;
  }
  let check: () => void;
  try {
    check =
      context.transport === identityRoutingTransport
        ? captureRealAuthority()
        : () => {};
  } catch {
    context.store.publish({ ...IDLE, signedOut: true });
    return;
  }
  const originalModel = context.model;
  context.store.publish({ ...IDLE, busy: true });
  void context.model.load().then((step) => {
    if (
      context.readFor !== who ||
      operation !== context.epoch ||
      originalModel !== context.model
    )
      return;
    if (!authorityStillCurrent(check)) {
      context.store.publish({ ...IDLE, error: "Session changed. Try again." });
      return;
    }
    const view = settled(step);
    context.store.publish({
      ...view,
      state: step.error === null ? view.state : null,
    });
  });
}

export function createRoutingSession(
  identity: RoutingIdentity,
  transport: RoutingTransport = identityRoutingTransport,
) {
  const context: SessionContext = {
    identity,
    transport,
    model: createNotificationRouting(transport),
    store: viewStore(),
    readFor: undefined,
    epoch: 0,
  };
  const { store } = context;
  const run = (work: () => Promise<RoutingStep>) =>
    runRoutingOperation(context, work);
  const ensure = () => ensureRoutingSession(context);

  const files: VirtualFileProvider = notificationRoutingFiles({
    current: () => {
      // Listed while Settings renders: the read starts after that render,
      // never inside it.
      queueMicrotask(ensure);
      return store.view().state;
    },
    replace: async (document: NotificationRoutingDocument) => {
      const step = await run(() => context.model.replace(document));
      return (
        step ?? {
          state: context.model.state(),
          status: null,
          error: "Another change is still being saved. Try again.",
        }
      );
    },
  });

  return {
    files,
    ensure,
    view: store.view,
    subscribe: store.subscribe,
    /** Read again, whoever it is for. */
    reload(): void {
      context.readFor = undefined;
      ensure();
    },
    edit: (edit: RoutingEdit) => run(() => context.model.edit(edit)),
    bind: (kind: NotificationChannelKind) =>
      run(() => context.model.bind(kind)),
    unbind: (id: string) => run(() => context.model.unbind(id)),
    showRoute: (cls: NotificationClass) =>
      run(() => context.model.showRoute(cls)),
    /** Drop the state and every listener; nothing is sent. */
    dispose: () => {
      context.epoch += 1;
      store.close();
    },
  };
}

export type RoutingSession = ReturnType<typeof createRoutingSession>;
