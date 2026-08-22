import { afterEach, describe, expect, it } from "vitest";
import {
  clearNotices,
  dismissNotice,
  listNotices,
  pushNotice,
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
});
