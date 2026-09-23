import { afterEach, describe, expect, it } from "vitest";
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

  it("notifies subscribers only for real changes and stops after unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribeNotices(() => {
      calls += 1;
    });
    expect(() => dismissNotice("missing")).not.toThrow();
    expect(calls).toBe(0);
    const notice = pushNotice({
      id: "notice-one",
      kind: "guest_claim",
      title: "Claim",
      body: "Body",
    });
    expect(calls).toBe(1);
    dismissNotice("missing");
    expect(calls).toBe(1);
    dismissNotice(notice.id);
    expect(calls).toBe(2);
    clearNotices();
    expect(calls).toBe(2);
    pushNotice({ kind: "guest_claim", title: "Again", body: "Again" });
    expect(calls).toBe(3);
    clearNotices();
    expect(calls).toBe(4);
    unsubscribe();
    pushNotice({ kind: "guest_claim", title: "Silent", body: "Silent" });
    expect(calls).toBe(4);
  });
});
