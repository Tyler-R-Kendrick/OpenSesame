import { describe, expect, it } from "vitest";
import { tailscaleCandidates } from "./tailscale.js";
import { normalizeTailnetBase } from "./urls.js";

describe("tailnet pairing", () => {
  it("lists MagicDNS and loopback candidates", () => {
    expect(tailscaleCandidates("https://laptop.tail.ts.net")).toEqual([
      "https://laptop.tail.ts.net",
      "https://opensesame",
      "https://opensesame-daemon",
      "http://opensesame:18790",
      "http://opensesame-daemon:18790",
      "http://127.0.0.1:18790",
    ]);
  });

  it("allows Tailscale HTTPS and CGNAT, not arbitrary http", () => {
    expect(normalizeTailnetBase("https://laptop.foo.ts.net/host")).toBe(
      "https://laptop.foo.ts.net/host",
    );
    expect(normalizeTailnetBase("http://opensesame:18790")).toBe(
      "http://opensesame:18790",
    );
    expect(normalizeTailnetBase("http://100.64.1.8:18790")).toBe(
      "http://100.64.1.8:18790",
    );
    expect(normalizeTailnetBase("http://10.0.0.5:18790")).toBeNull();
  });
});
