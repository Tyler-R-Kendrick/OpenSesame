/**
 * The semantic target registry.
 *
 * A support model names controls the way a person does — `nav.connections`,
 * `shell.lock` — and this registry is the only thing that knows what those
 * names point at. The model never sees a selector, never sees an element, and
 * cannot invent an identifier: an id that is not declared in `catalog.ts` is
 * rejected before the runtime reaches the DOM.
 *
 * Mount bindings come from React refs, so a target survives a visual
 * refactor that would break any selector written against the same control.
 */

import type { GuideTargetId, GuideWaitEvent } from "@opensesame/guide-lang";
import type {
  SupportTargetDescription,
  SupportTargetRole,
} from "@opensesame/support-agent";
import { GUIDE_TARGETS } from "./catalog.js";
import { inDevelopment } from "./dev.js";
import { type GuideRouteId, guideRouteWithin } from "./routes.js";

export type GuideTargetDescriptor = {
  readonly id: GuideTargetId;
  /**
   * Authored, checked-in prose. Never a user-created label — no vault item
   * name, folder name, account address or connection title may appear here.
   */
  readonly description: string;
  readonly role: SupportTargetRole;
  /** Routes the control can appear on. Empty means "anywhere in the shell". */
  readonly routes: readonly GuideRouteId[];
  /** The ADR-0065 capability this control exercises, when it exercises one. */
  readonly capabilityId: string | null;
};

type MountedTarget = {
  readonly descriptor: GuideTargetDescriptor;
  readonly element: HTMLElement;
  readonly detach: () => void;
};

type ActivationListener = () => void;

const descriptorsById = new Map<GuideTargetId, GuideTargetDescriptor>();
for (const descriptor of GUIDE_TARGETS) {
  if (descriptorsById.has(descriptor.id)) {
    throw new Error(`guide_target_declared_twice:${descriptor.id}`);
  }
  descriptorsById.set(descriptor.id, descriptor);
}

/**
 * Candidates per target, in mount order.
 *
 * A responsive shell renders the same destination twice — Connections is a rail
 * row on a desktop and a tab-bar link on a phone — and exactly one of them is
 * visible at any width. Binding a target to a single element would therefore
 * make every navigation guide fail closed on whichever form factor lost the
 * race, so a target may hold several candidates and resolution picks the first
 * one that can actually be pointed at.
 *
 * A duplicate is now the thing it always should have been: the *same* element
 * registered twice.
 */
const mounted = new Map<GuideTargetId, MountedTarget[]>();
const mountListeners = new Set<() => void>();
const activationListeners = new Map<GuideTargetId, Set<ActivationListener>>();
const duplicateMounts: string[] = [];

function announce(): void {
  for (const listener of [...mountListeners]) listener();
}

function fireActivation(id: GuideTargetId): void {
  const listeners = activationListeners.get(id);
  if (!listeners) return;
  for (const listener of [...listeners]) listener();
}

/**
 * Binds a declared target to a live element. Returns the unbind function the
 * React effect calls on unmount.
 *
 * Activation is observed passively, in the capture phase, so a guide can tell
 * that the person acted without the tutorial ever standing between them and
 * the control. The listener only reports; it never calls `preventDefault`,
 * never synthesises an event and never activates anything itself.
 */
export function mountGuideTarget(
  id: GuideTargetId,
  element: HTMLElement,
): () => void {
  const descriptor = descriptorsById.get(id);
  if (!descriptor) {
    throw new Error(`guide_target_undeclared:${id}`);
  }
  const candidates = mounted.get(id) ?? [];
  if (candidates.some((candidate) => candidate.element === element)) {
    duplicateMounts.push(id);
    if (inDevelopment()) {
      throw new Error(`guide_target_mounted_twice:${id}`);
    }
    return () => {};
  }

  const onActivate = () => fireActivation(id);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") fireActivation(id);
  };
  element.addEventListener("click", onActivate, { capture: true });
  element.addEventListener("keyup", onKey, { capture: true });

  const entry: MountedTarget = {
    descriptor,
    element,
    detach: () => {
      element.removeEventListener("click", onActivate, { capture: true });
      element.removeEventListener("keyup", onKey, { capture: true });
    },
  };
  mounted.set(id, [...candidates, entry]);
  announce();

  return () => {
    const live = mounted.get(id);
    if (!live) return;
    const remaining = live.filter((candidate) => candidate !== entry);
    if (remaining.length === live.length) return;
    entry.detach();
    if (remaining.length === 0) mounted.delete(id);
    else mounted.set(id, remaining);
    announce();
  };
}

export function isKnownGuideTarget(id: GuideTargetId): boolean {
  return descriptorsById.has(id);
}

/**
 * Whether a mounted element can actually be pointed at.
 *
 * Several controls exist twice — the vault filters are chips on a phone and
 * rail rows on a desktop — and only one copy can hold a target, because an id
 * binds to exactly one element. The other copy is still in the document, just
 * hidden by a media query, so registration alone would tell a model that an
 * invisible control is available and let it highlight a zero-box element.
 *
 * The check walks the ancestor chain for `display: none` / `visibility:
 * hidden` rather than measuring a box: layout is what jsdom does not have, and
 * a rule that behaved differently under test than in a browser would be worse
 * than no rule. A style the cascade never applied reads as visible, which is
 * the honest answer for a document that was never laid out.
 */
function isPointable(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  const view = element.ownerDocument.defaultView;
  if (!view) return true;
  let node: HTMLElement | null = element;
  while (node) {
    const style = view.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    node = node.parentElement;
  }
  return true;
}

export function isMountedGuideTarget(id: GuideTargetId): boolean {
  return resolveGuideTargetElement(id) !== null;
}

/**
 * The single place a `GuideTargetId` becomes an element. Nothing else in the
 * app may resolve a target, and no caller may pass a string that did not come
 * from `catalog.ts`.
 */
export function resolveGuideTargetElement(
  id: GuideTargetId,
): HTMLElement | null {
  const candidates = mounted.get(id) ?? [];
  for (const candidate of candidates) {
    if (isPointable(candidate.element)) return candidate.element;
  }
  return null;
}

export function guideTargetDescriptor(
  id: GuideTargetId,
): GuideTargetDescriptor | null {
  return descriptorsById.get(id) ?? null;
}

export function guideTargetIds(): readonly GuideTargetId[] {
  return [...descriptorsById.keys()];
}

export function guideTargetDescriptors(): readonly GuideTargetDescriptor[] {
  return GUIDE_TARGETS;
}

/** Duplicate mounts seen this session; the registry test asserts it is empty. */
export function duplicateGuideTargetMounts(): readonly string[] {
  return [...duplicateMounts];
}

export function subscribeToGuideTargets(listener: () => void): () => void {
  mountListeners.add(listener);
  return () => {
    mountListeners.delete(listener);
  };
}

/**
 * Sanitized snapshot for model context. Deliberately returns descriptions and
 * a mounted flag — never an `HTMLElement`, never a `resolveElement` closure,
 * and never anything read out of the live DOM.
 */
export function describeGuideTargets(
  route: GuideRouteId,
): readonly SupportTargetDescription[] {
  const out: SupportTargetDescription[] = [];
  for (const descriptor of GUIDE_TARGETS) {
    const scoped =
      descriptor.routes.length === 0 ||
      descriptor.routes.some((candidate) => guideRouteWithin(route, candidate));
    if (!scoped) continue;
    out.push({
      id: descriptor.id,
      description: descriptor.description,
      role: descriptor.role,
      mounted: isMountedGuideTarget(descriptor.id),
    });
  }
  return out;
}

/**
 * Settles when the target reaches `event`. The runtime owns every deadline, so
 * this never resolves on a timer of its own — only on the observation or on
 * `signal`.
 */
export function observeGuideTarget(
  id: GuideTargetId,
  event: GuideWaitEvent,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    // Pointability, not registration — the same question `focus` asks. The
    // rail and the phone tab bar both register their copy of a destination,
    // so a wait satisfied by mere registration would resolve on the hidden
    // one and hand the next instruction a control nobody can see.
    const satisfied = () =>
      event === "appear"
        ? isMountedGuideTarget(id)
        : event === "disappear"
          ? !isMountedGuideTarget(id)
          : false;

    let stop = () => {};
    const finish = () => {
      stop();
      resolve();
    };

    if (satisfied()) {
      queueMicrotask(resolve);
      return;
    }

    const onAbort = () => {
      stop();
      reject(new DOMException("aborted", "AbortError"));
    };

    if (event === "activate") {
      const listeners = activationListeners.get(id) ?? new Set();
      listeners.add(finish);
      activationListeners.set(id, listeners);
      stop = () => {
        listeners.delete(finish);
        if (listeners.size === 0) activationListeners.delete(id);
        signal.removeEventListener("abort", onAbort);
      };
    } else {
      const check = () => {
        if (satisfied()) finish();
      };
      mountListeners.add(check);
      stop = () => {
        mountListeners.delete(check);
        signal.removeEventListener("abort", onAbort);
      };
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Drops every live binding. Vault lock calls this. */
export function clearMountedGuideTargets(): void {
  for (const candidates of mounted.values()) {
    for (const candidate of candidates) candidate.detach();
  }
  mounted.clear();
  activationListeners.clear();
  announce();
}
