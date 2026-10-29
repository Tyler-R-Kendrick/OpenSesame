import { describe, expect, it } from "vitest";
import { resolvePinnedAddress } from "./vnet-pinned-fetch.js";

describe("pinned relay DNS", () => {
  it("refuses private, mixed and IPv6 destinations", async () => {
    await expect(resolvePinnedAddress("127.0.0.1", false)).rejects.toThrow(
      /public IPv4/u,
    );
    await expect(
      resolvePinnedAddress("169.254.169.254", false),
    ).rejects.toThrow(/public IPv4/u);
    await expect(resolvePinnedAddress("::1", true)).rejects.toThrow(/IPv6/u);
    await expect(
      resolvePinnedAddress("mixed.example", false, async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow(/public IPv4/u);
    expect(
      await resolvePinnedAddress("good.example", false, async () => [
        { address: "8.8.8.8", family: 4 },
      ]),
    ).toBe("8.8.8.8");
    expect(await resolvePinnedAddress("localhost", true)).toBe("127.0.0.1");
  });
});
