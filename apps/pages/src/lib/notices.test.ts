import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearNotices,
  dismissNotice,
  listNotices,
  pushNotice,
  subscribeNotices,
} from "./notices.js";

const guestClaim = (body: string) =>
  ({
    kind: "guest_claim",
    title: "Claim this guest session",
    body,
  }) as const;

afterEach(() => {
  clearNotices();
});

describe("notices", () => {
  it("keeps a single guest-claim notice and can dismiss it", () => {
    pushNotice({
      kind: "guest_claim",
      title: "Claim this guest session",
      body: "first",
      userCode: "AAAA-BBBB",
    });
    pushNotice({
      kind: "guest_claim",
      title: "Claim this guest session",
      body: "second",
      userCode: "CCCC-DDDD",
    });
    const notices = listNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toBe("second");
    expect(notices[0]?.userCode).toBe("CCCC-DDDD");
    dismissNotice(notices[0]?.id ?? "");
    expect(listNotices()).toHaveLength(0);
  });

  it("leaves the list alone when the dismissed id is not present", () => {
    const notice = pushNotice(guestClaim("only"));
    dismissNotice(`${notice.id}-not-a-real-id`);
    expect(listNotices()).toHaveLength(1);
    expect(listNotices()[0]?.id).toBe(notice.id);
  });

  it("honours a caller-supplied id and stamps createdAt", () => {
    const notice = pushNotice({ ...guestClaim("fixed"), id: "notice-1" });
    expect(notice.id).toBe("notice-1");
    expect(Number.isNaN(Date.parse(notice.createdAt))).toBe(false);
    expect(listNotices()[0]).toBe(notice);
  });
});

describe("subscribeNotices", () => {
  it("tells a subscriber about a push, a dismiss, and a clear", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNotices(listener);

    const notice = pushNotice(guestClaim("first"));
    expect(listener).toHaveBeenCalledTimes(1);

    dismissNotice(notice.id);
    expect(listener).toHaveBeenCalledTimes(2);

    pushNotice(guestClaim("second"));
    clearNotices();
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
  });

  it("stops delivering once unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNotices(listener);

    pushNotice(guestClaim("before"));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    pushNotice(guestClaim("after"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reaches every subscriber, and unsubscribing one leaves the others", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeNotices(first);
    const unsubscribeSecond = subscribeNotices(second);

    pushNotice(guestClaim("fan-out"));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    clearNotices();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);

    unsubscribeSecond();
  });

  // A no-op must stay silent: a subscriber that re-renders on every call would
  // otherwise redraw the bell for a dismiss that removed nothing.
  it("stays silent when a dismiss or a clear changes nothing", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNotices(listener);

    dismissNotice("never-pushed");
    expect(listener).not.toHaveBeenCalled();

    clearNotices();
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });
});
