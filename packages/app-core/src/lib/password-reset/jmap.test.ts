import type { JsonValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { JmapError, type MailFetch, readRecentMessages } from "./jmap.js";
import type { MailConnection } from "./mailbox-connection.js";

const CONNECTION: MailConnection = {
  origin: "https://mail.example.com",
  username: "me@example.com",
  password: "app-password-1",
  address: "me@example.com",
};

const SINCE = new Date("2026-10-11T10:00:00.000Z");

const SESSION_URL = "https://mail.example.com/jmap/session";
const WELL_KNOWN_URL = "https://mail.example.com/.well-known/jmap";
const API_URL = "https://mail.example.com/jmap/api";

type Seen = { url: string; init: RequestInit };
type Route = readonly [url: string, answer: () => Response];

const json = (body: JsonValue, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const SESSION = {
  apiUrl: API_URL,
  primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-1" },
  accounts: { "acct-1": {} },
};

const EMAILS = {
  methodResponses: [
    ["Email/query", { ids: ["m1", "m2"] }, "q"],
    [
      "Email/get",
      {
        list: [
          {
            id: "m1",
            subject: "Reset your password",
            textBody: [{ partId: "1" }],
            bodyValues: {
              "1": { value: "Open https://example.com/reset/abc" },
            },
          },
          { id: "m2", subject: "Receipt", textBody: [], bodyValues: {} },
          { notAnId: true },
        ],
      },
      "g",
    ],
  ],
};

/** A server that answers the routes it is given and 404s the rest. */
function server(routes: readonly Route[], seen: Seen[] = []): MailFetch {
  return async (url, init) => {
    seen.push({ url, init });
    const found = routes.find(([route]) => route === url);
    return found ? found[1]() : json({}, 404);
  };
}

const WORKING: readonly Route[] = [
  [SESSION_URL, () => json(SESSION)],
  [API_URL, () => json(EMAILS)],
];

describe("reading recent mail over JMAP", () => {
  it("opens the session, asks for the messages since a time, and maps them", async () => {
    const seen: Seen[] = [];
    const messages = await readRecentMessages(
      CONNECTION,
      server(WORKING, seen),
      { since: SINCE },
    );
    expect(messages).toEqual([
      {
        id: "m1",
        mailbox: "me@example.com",
        subject: "Reset your password",
        text: "Open https://example.com/reset/abc",
      },
      { id: "m2", mailbox: "me@example.com", subject: "Receipt", text: "" },
    ]);
    const call = JSON.parse(String(seen[1]?.init.body));
    expect(call.using).toEqual([
      "urn:ietf:params:jmap:core",
      "urn:ietf:params:jmap:mail",
    ]);
    expect(call.methodCalls[0][1]).toMatchObject({
      accountId: "acct-1",
      filter: { after: "2026-10-11T10:00:00.000Z" },
    });
    // The login goes by Basic with a username, and nothing follows a redirect.
    expect(seen[0]?.init.headers).toMatchObject({
      authorization: `Basic ${btoa("me@example.com:app-password-1")}`,
    });
    expect(seen.every((entry) => entry.init.redirect === "manual")).toBe(true);
    expect(seen.every((entry) => entry.init.credentials === "omit")).toBe(true);
  });

  it("sends a bearer token when the mailbox has no username", async () => {
    const seen: Seen[] = [];
    await readRecentMessages(
      { ...CONNECTION, username: "", password: "token-1" },
      server(WORKING, seen),
      { since: SINCE },
    );
    expect(seen[0]?.init.headers).toMatchObject({
      authorization: "Bearer token-1",
    });
  });

  it("falls back to the well-known address when the first has no session", async () => {
    const messages = await readRecentMessages(
      CONNECTION,
      server([
        [WELL_KNOWN_URL, () => json(SESSION)],
        [API_URL, () => json(EMAILS)],
      ]),
      { since: SINCE },
    );
    expect(messages).toHaveLength(2);
  });

  it("takes the first account when the server names no primary mail account", async () => {
    const seen: Seen[] = [];
    await readRecentMessages(
      CONNECTION,
      server(
        [
          [
            SESSION_URL,
            () => json({ apiUrl: API_URL, accounts: { first: {} } }),
          ],
          [API_URL, () => json(EMAILS)],
        ],
        seen,
      ),
      { since: SINCE },
    );
    expect(
      JSON.parse(String(seen[1]?.init.body)).methodCalls[0][1].accountId,
    ).toBe("first");
  });
});

describe("when the server cannot be read", () => {
  const refusal = async (fetcher: MailFetch) => {
    try {
      await readRecentMessages(CONNECTION, fetcher, { since: SINCE });
    } catch (error) {
      if (error instanceof JmapError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  };

  it("says unauthorized for a refused login, at the session or the api", async () => {
    expect(
      (await refusal(server([[SESSION_URL, () => json({}, 401)]]))).code,
    ).toBe("unauthorized");
    expect(
      (
        await refusal(
          server([
            [SESSION_URL, () => json(SESSION)],
            [API_URL, () => json({}, 403)],
          ]),
        )
      ).code,
    ).toBe("unauthorized");
  });

  it("says unreachable when the request cannot be made", async () => {
    const failing: MailFetch = async () => {
      throw new TypeError("network down");
    };
    expect((await refusal(failing)).code).toBe("unreachable");
  });

  it("refuses an api address on another origin, so the login stays where it was named", async () => {
    const seen: Seen[] = [];
    const error = await refusal(
      server(
        [
          [
            SESSION_URL,
            () =>
              json({ ...SESSION, apiUrl: "https://evil.example.net/jmap/api" }),
          ],
        ],
        seen,
      ),
    );
    expect(error.code).toBe("malformed");
    expect(seen.map((entry) => entry.url)).toEqual([SESSION_URL]);
  });

  it("says unsupported when there is no session or the call answers an error", async () => {
    expect((await refusal(server([]))).code).toBe("unsupported");
    expect(
      (
        await refusal(
          server([
            [SESSION_URL, () => json(SESSION)],
            [
              API_URL,
              () =>
                json({
                  methodResponses: [["error", { type: "serverFail" }, "q"]],
                }),
            ],
          ]),
        )
      ).code,
    ).toBe("unsupported");
  });

  it("says malformed for a body that is not JSON or the wrong shape", async () => {
    expect(
      (
        await refusal(
          server([
            [SESSION_URL, () => new Response("<html>", { status: 200 })],
          ]),
        )
      ).code,
    ).toBe("malformed");
    expect(
      (
        await refusal(
          server([
            [SESSION_URL, () => json(SESSION)],
            [API_URL, () => json({ methodResponses: 7 })],
          ]),
        )
      ).code,
    ).toBe("malformed");
  });

  it("never puts the login or the server's words in an error", async () => {
    const error = await refusal(
      server([
        [
          SESSION_URL,
          () => json({ error: "bad app-password-1 for me@example.com" }, 500),
        ],
      ]),
    );
    expect(error.message).not.toContain("app-password-1");
    expect(error.message).not.toContain("me@example.com");
  });
});
