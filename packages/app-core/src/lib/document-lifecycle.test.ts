import { describe, expect, it } from "vitest";
import {
  persistedRestoreRefuses,
  trustedHideRetires,
} from "./document-lifecycle.js";

const hide = {
  trusted: true,
  hidden: true,
  lockOnHide: true,
  unlocked: true,
};

describe("trusted hide", () => {
  it("retires a trusted hidden document when lock-on-hide is on and the vault is open", () => {
    expect(trustedHideRetires(hide)).toBe(true);
  });

  it("ignores a script-dispatched hide, a visible document, a disabled preference, and a locked vault", () => {
    expect(trustedHideRetires({ ...hide, trusted: false })).toBe(false);
    expect(trustedHideRetires({ ...hide, hidden: false })).toBe(false);
    expect(trustedHideRetires({ ...hide, lockOnHide: false })).toBe(false);
    expect(trustedHideRetires({ ...hide, unlocked: false })).toBe(false);
  });
});

describe("persisted pageshow", () => {
  it("refuses authority that was live when the document was frozen", () => {
    expect(
      persistedRestoreRefuses({ persisted: true, hadAuthority: true }),
    ).toBe(true);
  });

  it("keeps a fresh document and a restore that was already idle", () => {
    expect(
      persistedRestoreRefuses({ persisted: false, hadAuthority: true }),
    ).toBe(false);
    expect(
      persistedRestoreRefuses({ persisted: true, hadAuthority: false }),
    ).toBe(false);
  });
});
