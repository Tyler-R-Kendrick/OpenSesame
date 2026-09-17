import { describe, expect, it } from "vitest";
import {
  generateWalletWrappingKey,
  openWalletMaterial,
  sealWalletMaterial,
} from "./wrap.js";

describe("sealWalletMaterial (WAL-B18)", () => {
  it("child wrapping keys cannot open parent-sealed material", async () => {
    const parentKey = await generateWalletWrappingKey();
    const childKey = await generateWalletWrappingKey();
    const secret = new TextEncoder().encode("CANARY_parent_root_wrap");
    const sealed = await sealWalletMaterial(secret, parentKey);
    const opened = await openWalletMaterial(sealed, parentKey);
    expect(new TextDecoder().decode(opened)).toBe("CANARY_parent_root_wrap");
    await expect(openWalletMaterial(sealed, childKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("raw", parentKey)).rejects.toThrow();
  });
});
