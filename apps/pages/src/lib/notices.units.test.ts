/** @vitest-environment jsdom */
/**
 * Atomic unit tests for the notice store.
 *
 * `notices.ts` is in the Stryker `mutate` set at a 100% break threshold, so
 * every branch, every `emit()` and every filter predicate here is pinned by an
 * assertion that fails if the behavior changes. Notices drive the "you still
 * need to attach your sign-in" prompt (ADR 0033 §4), so a silently dropped
 * emit or a broken dedupe is a user-visible loss, not cosmetic.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearNotices,
  dismissNotice,
  listNotices,
  pushNotice,
  subscribeNotices,
} from "./notices.js";

afterEach(() => {
  clearNotices();
});

function push(
  kind: "guest_claim" | "federated_link",
  title = "t",
  id?: string,
) {
  return pushNotice({
    kind,
    title,
    body: "b",
    ...(id !== undefined ? { id } : undefined),
  });
}

describe("pushNotice", () => {
  it("returns the stored notice, with a generated id and timestamp", () => {
    const notice = push("guest_claim");
    expect(notice.id).toBeTruthy();
    expect(notice.createdAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(notice.createdAt))).toBe(false);
    expect(listNotices()).toEqual([notice]);
  });

  it("honors an explicit id instead of generating one", () => {
    expect(push("guest_claim", "t", "fixed-id").id).toBe("fixed-id");
  });

  it("replaces any existing notice of the same kind", () => {
    push("guest_claim", "first");
    const second = push("guest_claim", "second");
    expect(listNotices()).toEqual([second]);
    expect(listNotices()).toHaveLength(1);
  });

  it("keeps notices of a different kind", () => {
    const guest = push("guest_claim");
    const federated = push("federated_link");
    // Order matters: the survivor stays first, the new one is appended.
    expect(listNotices()).toEqual([guest, federated]);
  });

  it("notifies subscribers", () => {
    const listener = vi.fn();
    subscribeNotices(listener);
    push("guest_claim");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("subscribeNotices", () => {
  it("stops notifying after the returned unsubscribe runs", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNotices(listener);
    push("guest_claim");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    push("federated_link");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies every registered subscriber", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeNotices(a);
    const offB = subscribeNotices(b);
    push("guest_claim");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    offB();
  });
});

describe("dismissNotice", () => {
  it("removes only the named notice and emits", () => {
    const guest = push("guest_claim");
    const federated = push("federated_link");
    const listener = vi.fn();
    subscribeNotices(listener);

    dismissNotice(guest.id);
    expect(listNotices()).toEqual([federated]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not emit when the id matches nothing", () => {
    push("guest_claim");
    const listener = vi.fn();
    subscribeNotices(listener);

    dismissNotice("no-such-id");
    expect(listNotices()).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("clearNotices", () => {
  it("empties the list and emits", () => {
    push("guest_claim");
    const listener = vi.fn();
    subscribeNotices(listener);

    clearNotices();
    expect(listNotices()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not emit when already empty", () => {
    const listener = vi.fn();
    subscribeNotices(listener);

    clearNotices();
    expect(listener).not.toHaveBeenCalled();
  });
});
