import { expect, it } from "vitest";
import { bitwardenNativeNetworkPolicy } from "./bitwarden-native-network-policy.js";
import { NativeFetchRequest } from "./bitwarden-native-network-protocol.js";
const ID = "00000000-0000-4000-8000-000000000001";
function request(
  url: string,
  method = "GET",
  headers = [["authorization", "Bearer owned-token"]],
  body = "",
) {
  return NativeFetchRequest.parse({
    type: "native-fetch",
    id: 1,
    url,
    method,
    headers,
    body,
  });
}
it("allows only fixed native account routes inside captured tenant prefixes", () => {
  const approve = bitwardenNativeNetworkPolicy(
    "https://provider.example/tenant/api",
    "https://provider.example/tenant/identity",
  );
  const api = "https://provider.example/tenant/api/";
  const identity = "https://provider.example/tenant/identity/";
  expect(approve(request(`${api}sync?excludeDomains=true`))).toBe(
    64 * 1024 * 1024,
  );
  expect(approve(request(`${api}ciphers/${ID}`))).toBe(8 * 1024 * 1024);
  expect(
    approve(
      request(
        `${api}ciphers`,
        "POST",
        [
          ["authorization", "Bearer owned-token"],
          ["content-type", "application/json"],
        ],
        "{}",
      ),
    ),
  ).toBe(8 * 1024 * 1024);
  expect(approve(request(`${api}ciphers/${ID}/delete`, "PUT"))).toBe(0);
  expect(
    approve(
      request(
        `${identity}accounts/prelogin/password`,
        "POST",
        [["content-type", "application/json"]],
        "{}",
      ),
    ),
  ).toBe(64 * 1024);
  expect(
    approve(
      request(
        `${identity}accounts/prelogin`,
        "POST",
        [["content-type", "application/json"]],
        "{}",
      ),
    ),
  ).toBe(64 * 1024);
  expect(
    approve(
      request(
        `${identity}connect/token`,
        "POST",
        [["content-type", "application/x-www-form-urlencoded"]],
        "scope=api",
      ),
    ),
  ).toBe(64 * 1024);
  for (const denied of [
    request("https://other.example/tenant/api/sync?excludeDomains=true"),
    request(`${api}../sync?excludeDomains=true`),
    request(`${api}%2e%2e/sync?excludeDomains=true`),
    request(`${api}ciphers/%2f${ID}`),
    request(`${api}sync?excludeDomains=true&extra=1`),
    request(`${api}sync?excludeDomains=true#fragment`),
    request(`${api}organizations`),
    request(`${api}ciphers/${ID}`, "POST"),
    request(`${api}ciphers/${ID}`, "GET", []),
    request(`${api}ciphers/${ID}`, "GET", [
      ["authorization", "Bearer wrong token"],
    ]),
    request(`${api}ciphers/${ID}`, "GET", [
      ["authorization", "Bearer owned-token"],
      ["cookie", "private"],
    ]),
    request(`${api}ciphers/${ID}`, "GET", [
      ["authorization", "Bearer owned-token"],
      ["Authorization", "Bearer other"],
    ]),
    request(
      `${api}ciphers/${ID}`,
      "GET",
      [["authorization", "Bearer owned-token"]],
      "not empty",
    ),
    request(
      `${identity}connect/token`,
      "POST",
      [
        ["authorization", "Bearer owned-token"],
        ["content-type", "application/x-www-form-urlencoded"],
      ],
      "scope=api",
    ),
    request(
      `${identity}connect/token`,
      "POST",
      [["content-type", "text/plain"]],
      "scope=api",
    ),
    request(
      `${identity}accounts/prelogin`,
      "POST",
      [["content-type", "application/json"]],
      "🔐".repeat(16385),
    ),
  ])
    expect(() => approve(denied)).toThrow();
});
