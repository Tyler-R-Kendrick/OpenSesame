import { describe, expect, it } from "vitest";
import { CookieJar } from "./vnet-cookie-jar.js";

function cookies(...lines: string[]): Headers {
  const headers = new Headers();
  for (const line of lines) headers.append("set-cookie", line);
  return headers;
}

describe("virtual network cookies", () => {
  it("enforces Secure, path, expiry, and host-only domain scope", () => {
    const jar = new CookieJar();
    const url = new URL("https://accounts.example.test/reset/start");
    jar.store(
      url,
      cookies(
        "auth=secret; Secure; Path=/reset",
        "gone=x; Max-Age=0",
        "domain=x; Domain=example.test",
        "exact=y; Domain=.accounts.example.test; Secure; Path=/",
        "__Host-invalid=x; Domain=accounts.example.test; Secure; Path=/",
        "plain=x; Path=/",
      ),
    );
    expect(jar.header(new URL("https://accounts.example.test/reset/go"))).toBe(
      "auth=secret; exact=y; plain=x",
    );
    expect(jar.header(new URL("http://accounts.example.test/reset/go"))).toBe(
      "plain=x",
    );
    expect(jar.header(new URL("https://accounts.example.test/elsewhere"))).toBe(
      "exact=y; plain=x",
    );
    expect(jar.header(new URL("https://evil.example.test/reset/go"))).toBe("");
    jar.store(url, cookies("auth=; Secure; Path=/reset; Max-Age=0"));
    expect(jar.header(url)).toBe("exact=y; plain=x");
  });
});
