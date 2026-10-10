import type { BoundaryValue } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import {
  listNativeCodebergRepositories,
  verifyNativeCodebergIdentity,
} from "./native-codeberg-provider.js";
import type { NativeGrant } from "./native-connector-schema.js";

const grant: NativeGrant = {
  kind: "oauth",
  providerId: "codeberg",
  actor: "user",
  fingerprint: "a".repeat(64),
  accessToken: "private-codeberg-access",
  refreshToken: "private-codeberg-refresh",
  scopes: null,
  expiresAt: Date.now() + 3600_000,
  issuer: "https://codeberg.org",
  endpoint: "https://codeberg.org/login/oauth/access_token",
};
function authority(body: BoundaryValue, status = 200) {
  const fetch = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  return { fetch, assertCurrent: vi.fn() };
}
it("verifies an actual provider account with the issued token, not with saved settings", async () => {
  const transport = authority({
    id: 37,
    login: "codeberg-owner",
    full_name: "Codeberg owner",
  });
  expect(await verifyNativeCodebergIdentity(grant, transport)).toEqual({
    id: "37",
    label: "Codeberg owner",
    kind: "account",
    assurance: "account-verified",
  });
  const [url, init] = transport.fetch.mock.calls[0] ?? [];
  expect(String(url)).toBe("https://codeberg.org/api/v1/user");
  expect(new Headers(init?.headers).get("authorization")).toBe(
    `Bearer ${grant.accessToken}`,
  );
  expect(init).toMatchObject({
    mode: "cors",
    credentials: "omit",
    redirect: "error",
  });
});
it("uses the provider grant to list usable repositories", async () => {
  const transport = authority([
    {
      id: 71,
      full_name: "owner/project",
      html_url: "https://codeberg.org/owner/project",
    },
  ]);
  expect(await listNativeCodebergRepositories(grant, transport)).toEqual({
    label: "Codeberg repositories (up to 100)",
    items: [
      {
        id: "71",
        label: "owner/project",
        url: "https://codeberg.org/owner/project",
      },
    ],
  });
  expect(String(transport.fetch.mock.calls[0]?.[0])).toBe(
    "https://codeberg.org/api/v1/user/repos?limit=100",
  );
});
it.each([
  "https://attacker.example/owner/project",
  "https://codeberg.org/owner/project?access_token=private-codeberg-access",
  "https://private-codeberg-access@codeberg.org/owner/project",
])(
  "refuses repository result links that escape the approved provider: %s",
  async (html_url) => {
    await expect(
      listNativeCodebergRepositories(
        grant,
        authority([{ id: 71, full_name: "owner/project", html_url }]),
      ),
    ).rejects.toThrow();
  },
);
it("does not execute a repository operation with another provider's grant", async () => {
  const transport = authority([]);
  await expect(
    listNativeCodebergRepositories(
      { ...grant, providerId: "gitlab" },
      transport,
    ),
  ).rejects.toThrow();
  expect(transport.fetch).not.toHaveBeenCalled();
});
it.each([401, 403])(
  "refuses unauthorized provider proof: %s",
  async (status) => {
    await expect(
      verifyNativeCodebergIdentity(
        grant,
        authority({ id: 37, login: "owner" }, status),
      ),
    ).rejects.toThrow();
  },
);
