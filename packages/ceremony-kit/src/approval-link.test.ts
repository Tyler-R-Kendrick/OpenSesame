import { describe, expect, it } from "vitest";
import {
  approvalRefAt,
  isApprovalRef,
  readApprovalArrival,
} from "./approval-link.js";

const REF = "areq_Abc-123_xyzXYZ0123456789";
const AT = "https://example.test/OpenSesame";

describe("the approve link (ADR 0140 plan step 9)", () => {
  it("reads the reference at the tail of any base", () => {
    expect(approvalRefAt(`/approve/${REF}`)).toBe(REF);
    expect(approvalRefAt(`/OpenSesame/approve/${REF}`)).toBe(REF);
    expect(approvalRefAt("/approve/rz-QHXT-KPLM")).toBe("rz-QHXT-KPLM");
  });

  it("refuses anything but a bounded, URL-safe id — never repairs it", () => {
    for (const bad of [
      "",
      "a%2Fb",
      "..",
      "a.b",
      "a b",
      "x".repeat(129),
      "<script>",
    ]) {
      expect(isApprovalRef(bad), bad).toBe(false);
    }
    expect(approvalRefAt("/approve/a%2F..%2Fb")).toBeNull();
    expect(approvalRefAt("/approve/")).toBeNull();
    expect(approvalRefAt("/approve")).toBeNull();
    expect(approvalRefAt("/i/areq_1")).toBeNull();
  });

  it("leaves every other address alone", () => {
    expect(readApprovalArrival(`${AT}/device?user_code=X`)).toEqual({
      arrival: { kind: "none" },
      scrubbed: null,
    });
    expect(readApprovalArrival("not a url")).toEqual({
      arrival: { kind: "none" },
      scrubbed: null,
    });
  });

  it("reads a clean link without touching the address", () => {
    expect(readApprovalArrival(`${AT}/approve/${REF}`)).toEqual({
      arrival: { kind: "request", ref: REF },
      scrubbed: null,
    });
  });

  it("takes a query or fragment out, and keeps a harmless one's reference", () => {
    expect(readApprovalArrival(`${AT}/approve/${REF}?utm=chat#x`)).toEqual({
      arrival: { kind: "request", ref: REF },
      scrubbed: `/OpenSesame/approve/${REF}`,
    });
  });

  it("refuses a link that carried credential material, and scrubs it", () => {
    for (const tail of ["?access_token=abc", "#token=osc_clm_x", "#id_token=a"])
      expect(readApprovalArrival(`${AT}/approve/${REF}${tail}`)).toEqual({
        arrival: { kind: "refused" },
        scrubbed: `/OpenSesame/approve/${REF}`,
      });
  });

  it("refuses a reference of the wrong shape", () => {
    expect(readApprovalArrival(`${AT}/approve/a.b`)).toEqual({
      arrival: { kind: "refused" },
      scrubbed: null,
    });
  });

  it("does not read a query longer than a link needs", () => {
    const long = `${AT}/approve/${REF}?pad=${"x".repeat(2100)}`;
    expect(readApprovalArrival(long).arrival).toEqual({ kind: "refused" });
  });
});
