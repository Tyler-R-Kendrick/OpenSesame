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

export function createRoutingSession(
  identity: RoutingIdentity,
  transport: RoutingTransport = identityRoutingTransport,
) {
  let model: NotificationRouting = createNotificationRouting(transport);
  const store = viewStore();
  /** The identity the state was read for; a new one reads again. */
  let readFor: string | null | undefined;

  async function run(
    work: () => Promise<RoutingStep>,
  ): Promise<RoutingStep | null> {
    const view = store.view();
    if (view.busy || store.closed()) return null;
    store.publish({
      ...view,
      busy: true,
      status: null,
      error: null,
      begun: null,
    });
    const step = await work();
    store.publish(settled(step));
    return step;
  }

  /** Read (again) when the identity changed; forget when there is none. */
  function ensure(): void {
    if (store.closed()) return;
    const who = identity();
    if (who === readFor) return;
    readFor = who;
    model = createNotificationRouting(transport);
    if (who === null) {
      store.publish({ ...IDLE, signedOut: true });
      return;
    }
    store.publish({ ...IDLE, busy: true });
    void model.load().then((step) => {
      if (readFor !== who) return;
      const view = settled(step);
      store.publish({
        ...view,
        state: step.error === null ? view.state : null,
      });
    });
  }

  const files: VirtualFileProvider = notificationRoutingFiles({
    current: () => {
      // Listed while Settings renders: the read starts after that render,
      // never inside it.
      queueMicrotask(ensure);
      return store.view().state;
    },
    replace: async (document: NotificationRoutingDocument) => {
      const step = await run(() => model.replace(document));
      return (
        step ?? {
          state: model.state(),
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
      readFor = undefined;
      ensure();
    },
    edit: (edit: RoutingEdit) => run(() => model.edit(edit)),
    bind: (kind: NotificationChannelKind) => run(() => model.bind(kind)),
    unbind: (id: string) => run(() => model.unbind(id)),
    showRoute: (cls: NotificationClass) => run(() => model.showRoute(cls)),
    /** Drop the state and every listener; nothing is sent. */
    dispose: store.close,
  };
}

export type RoutingSession = ReturnType<typeof createRoutingSession>;
