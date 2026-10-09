import { expect, it, vi } from "vitest";
import type { NativeGrant } from "./native-connector-schema.js";
import { listNativeDiscordGuilds } from "./native-discord-operations.js";
const grant: NativeGrant = {
  kind: "oauth",
  providerId: "discord",
  actor: "user",
  fingerprint: "f".repeat(64),
  targetId: "user",
  issuer: "https://discord.com",
  endpoint: "https://discord.com/api/oauth2/token",
  clientId: "registered-app",
  accessToken: "private-observed-discord",
  expiresAt: Date.now() + 3600000,
  scopes: ["identify", "guilds"],
};
it("reads actual guild membership and returns safe Discord server links", async () => {
  const fetch = vi.fn(
    async (_url: RequestInfo | URL) =>
      new Response(JSON.stringify([{ id: "12345", name: "Own server" }]), {
        status: 200,
      }),
  );
  expect(
    await listNativeDiscordGuilds(grant, {
      fetch,
      assertCurrent: () => undefined,
    }),
  ).toEqual({
    label: "Discord servers (up to 200)",
    items: [
      {
        id: "12345",
        label: "Own server",
        url: "https://discord.com/channels/12345",
      },
    ],
  });
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "https://discord.com/api/v10/users/@me/guilds?limit=200",
  );
});
it("does not send a bearer without its actually granted guild membership permission", async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL) => new Response("[]"));
  await expect(
    listNativeDiscordGuilds(
      { ...grant, scopes: ["identify"] },
      { fetch, assertCurrent: () => undefined },
    ),
  ).rejects.toThrow("permissions");
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects a provider response trying to expose bearer material in a guild label", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify([{ id: "12345", name: grant.accessToken }])),
  );
  await expect(
    listNativeDiscordGuilds(grant, { fetch, assertCurrent: () => undefined }),
  ).rejects.toThrow();
});
