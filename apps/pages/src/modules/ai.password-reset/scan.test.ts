import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  installAutonomousResetReady,
  resetPasswordResetMailForTest,
} from "@opensesame/app-core/lib/password-reset-mail.js";
import { clearHandledForTest } from "@opensesame/app-core/lib/password-reset/handled.js";
import type { MailFetch } from "@opensesame/app-core/lib/password-reset/jmap.js";
import {
  JMAP_MAILBOX,
  mailboxItem,
} from "@opensesame/app-core/lib/password-reset/mailbox.test-support.js";
import type { JsonValue } from "@opensesame/os-domain";
import { type VaultItem, createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sectionCategory } from "../../sections/settings/CapabilitySections.js";
import { PASSWORD_RESET_PANEL_CATEGORY } from "./runtime.js";
import { createPasswordResetScan } from "./scan.js";

const NOW = Date.parse("2026-10-11T12:00:00.000Z");

const SESSION = {
  apiUrl: "https://mail.example.com/jmap/api",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-1" },
};

function login(resetEmailId: string | undefined, name = "Example") {
  const item = createItem("account", name);
  item.uris = [{ id: "u1", uri: "https://example.com/login", match: "host" }];
  if (resetEmailId) item.resetEmailId = resetEmailId;
  return item;
}

type Message = { id: string; subject: string; text: string };
type Reply = { readonly status: number } | { readonly messages: Message[] };

/** A JMAP server that answers `reply`, and counts the calls made to it. */
function server(reply: () => Reply) {
  const calls: string[] = [];
  const json = (body: JsonValue, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const fetcher: MailFetch = async (url) => {
    calls.push(url);
    const answer = reply();
    if ("status" in answer) return json({}, answer.status);
    if (url.endsWith("/jmap/session")) return json(SESSION);
    return json({
      methodResponses: [
        ["Email/query", { ids: [] }, "q"],
        [
          "Email/get",
          {
            list: answer.messages.map((message, index) => ({
              id: message.id,
              subject: message.subject,
              textBody: [{ partId: String(index) }],
              bodyValues: { [String(index)]: { value: message.text } },
            })),
          },
          "g",
        ],
      ],
    });
  };
  return { fetcher, calls };
}

const RESET_MAIL = {
  messages: [
    {
      id: "m1",
      subject: "Reset your password",
      text: "Open https://example.com/reset/abc?token=SECRET-TOKEN",
    },
  ],
};

function scanOf(
  items: VaultItem[],
  fetcher: MailFetch,
  handOff: (origin: string) => Promise<boolean>,
) {
  return createPasswordResetScan({
    fetch: fetcher,
    now: () => NOW,
    items: () => items,
    unlocked: () => true,
    handOff,
  });
}

beforeEach(() => {
  clearNotices();
  clearHandledForTest();
});

afterEach(() => {
  resetPasswordResetMailForTest();
  clearNotices();
  clearHandledForTest();
});

describe("password reset scan", () => {
  it("draws in the password-reset section", () => {
    expect(PASSWORD_RESET_PANEL_CATEGORY).toBe(
      sectionCategory("feature-password-reset"),
    );
  });

  it("announces a reset message once and does not hand off while the ceremony is off", async () => {
    const home = mailboxItem(JMAP_MAILBOX, "Home");
    const items = [home, login(home.id)];
    const posted: string[] = [];
    const { fetcher } = server(() => RESET_MAIL);
    const scan = scanOf(items, fetcher, async (origin) => {
      posted.push(origin);
      return true;
    });
    await scan.scan();
    await scan.scan();
    expect(posted).toEqual([]);
    const notices = listNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      title: "Password reset email",
      body: "A reset message for Example arrived.",
      tone: "info",
    });
  });

  it("hands the origin over once, retries one that did not land, and never sends the link", async () => {
    const uninstall = installAutonomousResetReady(() => true);
    const home = mailboxItem(JMAP_MAILBOX, "Home");
    const items = [home, login(home.id)];
    const posted: string[] = [];
    let ok = false;
    const { fetcher } = server(() => RESET_MAIL);
    const scan = scanOf(items, fetcher, async (origin) => {
      posted.push(origin);
      return ok;
    });
    await scan.scan();
    expect(posted).toEqual(["https://example.com"]);
    ok = true;
    await scan.scan();
    expect(posted).toEqual(["https://example.com", "https://example.com"]);
    await scan.scan();
    expect(posted).toHaveLength(2);
    // Announced the first time only, and no notice carries the token.
    expect(listNotices()).toHaveLength(1);
    expect(JSON.stringify(listNotices())).not.toContain("SECRET-TOKEN");
    uninstall();
  });

  it("acts again on a new message for the same login and site", async () => {
    const uninstall = installAutonomousResetReady(() => true);
    const home = mailboxItem(JMAP_MAILBOX, "Home");
    const items = [home, login(home.id)];
    const posted: string[] = [];
    let mail = RESET_MAIL;
    const { fetcher } = server(() => mail);
    const scan = scanOf(items, fetcher, async (origin) => {
      posted.push(origin);
      return true;
    });
    await scan.scan();
    mail = {
      messages: [
        {
          id: "m2",
          subject: "Reset your password",
          text: "https://example.com/reset/def",
        },
      ],
    };
    await scan.scan();
    expect(posted).toHaveLength(2);
    expect(listNotices()).toHaveLength(2);
    uninstall();
  });

  it("reads only a readable mailbox that a login names", async () => {
    const unbound = mailboxItem({
      ...JMAP_MAILBOX,
      address: "unbound@example.com",
    });
    const addressOnly = mailboxItem({ address: "plain@example.com" });
    const home = mailboxItem(JMAP_MAILBOX, "Home");
    const items = [unbound, addressOnly, home, login(addressOnly.id, "Plain")];
    const { fetcher, calls } = server(() => RESET_MAIL);
    await scanOf(items, fetcher, async () => true).scan();
    expect(calls).toEqual([]);
    expect(listNotices()).toEqual([]);
  });

  it("ignores a message for a login bound to another mailbox", async () => {
    const home = mailboxItem(JMAP_MAILBOX, "Home");
    const other = mailboxItem({ address: "other@example.com" });
    const items = [home, other, login(other.id)];
    const { fetcher } = server(() => RESET_MAIL);
    await scanOf(items, fetcher, async () => true).scan();
    expect(listNotices()).toEqual([]);
  });

  it("names a mailbox it could not read, in one notice, and clears it when it can", async () => {
    const home = mailboxItem(JMAP_MAILBOX, "Home");
    const items = [home, login(home.id)];
    let reply: () => Reply = () => ({ status: 401 });
    const { fetcher } = server(() => reply());
    const scan = scanOf(items, fetcher, async () => true);
    await scan.scan();
    await scan.scan();
    const failed = listNotices();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      tone: "warn",
      title: "Reset email not read",
      body: "Home: The mail server refused the login.",
    });
    expect(JSON.stringify(failed)).not.toContain("app-password-1");

    reply = () => ({ messages: [] });
    await scan.scan();
    expect(listNotices()).toEqual([]);
  });

  it("names a mailbox whose server address cannot be used, instead of skipping it quietly", async () => {
    const home = mailboxItem(
      {
        ...JMAP_MAILBOX,
        incoming: { host: "mail.example.com:8443", port: "" },
      },
      "Home",
    );
    const { fetcher, calls } = server(() => RESET_MAIL);
    await scanOf([home, login(home.id)], fetcher, async () => true).scan();
    expect(calls).toEqual([]);
    expect(listNotices()).toEqual([
      expect.objectContaining({
        tone: "warn",
        title: "Reset email not read",
        body: "Home: The mail server address could not be used.",
      }),
    ]);
  });

  it("does nothing while the vault is locked", async () => {
    const home = mailboxItem(JMAP_MAILBOX, "Home");
    const { fetcher, calls } = server(() => RESET_MAIL);
    const scan = createPasswordResetScan({
      fetch: fetcher,
      now: () => NOW,
      items: () => [home, login(home.id)],
      unlocked: () => false,
    });
    await scan.scan();
    expect(calls).toEqual([]);
  });

  it("checks every minute while the lease lasts, and stops with it", async () => {
    vi.useFakeTimers();
    try {
      const home = mailboxItem(JMAP_MAILBOX, "Home");
      const { fetcher, calls } = server(() => ({ messages: [] }));
      const scan = scanOf([home, login(home.id)], fetcher, async () => true);
      const lease = new AbortController();
      scan.start(lease.signal);
      await vi.advanceTimersByTimeAsync(0);
      const afterStart = calls.length;
      expect(afterStart).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(60_000);
      const afterMinute = calls.length;
      expect(afterMinute).toBeGreaterThan(afterStart);

      lease.abort();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(calls.length).toBe(afterMinute);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a check under a lease that is already over", async () => {
    vi.useFakeTimers();
    try {
      const home = mailboxItem(JMAP_MAILBOX, "Home");
      const { fetcher, calls } = server(() => ({ messages: [] }));
      const scan = scanOf([home, login(home.id)], fetcher, async () => true);
      const lease = new AbortController();
      lease.abort();
      scan.start(lease.signal);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
