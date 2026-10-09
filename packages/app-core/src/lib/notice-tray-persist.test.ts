/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { atRestReady } from "./at-rest/key.js";
import {
  installTrayNoticePersistence,
  restoreTrayNoticeHistory,
} from "./notice-tray-persist.js";
import { appendStatusNotice, clearNotices, listNotices } from "./notices.js";

afterEach(() => {
  clearNotices();
});

describe("notice tray persistence", () => {
  it("restores status history after reload", async () => {
    configureHost(createTestHost());
    installTrayNoticePersistence();
    appendStatusNotice({
      id: "identity.claim.test",
      tone: "err",
      title: "Claim",
      body: "That code did not match.",
      ceremony: "identity",
      ceremonyLabel: "Repair Identity",
      open: { to: "/unlock", label: "Unlock" },
    });
    await atRestReady();
    clearNotices();
    expect(listNotices()).toHaveLength(0);
    await restoreTrayNoticeHistory();
    expect(listNotices()).toMatchObject([
      {
        id: "identity.claim.test",
        tone: "err",
        body: "That code did not match.",
        ceremony: "identity",
        ceremonyLabel: "Repair Identity",
        open: { to: "/unlock", label: "Unlock" },
      },
    ]);
  });
});
