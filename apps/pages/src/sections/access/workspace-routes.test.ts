import { describe, expect, it } from "vitest";
import { accessPanel } from "../AccessSection.js";

describe("Access record routes", () => {
  it("opens Identity shares from its canonical path without a legacy fragment", () => {
    expect(accessPanel("grants", "", "/access/shares")).toBe("identity-shares");
    expect(accessPanel("grants", "", "/access/shares-extra")).toBe(
      "local-grants",
    );
  });
  it.each([
    ["grants", "#local-grants/grant-reference", "local-grants"],
    ["grants", "#share-existing-reference", "identity-shares"],
    ["grants", "#pending-existing-reference", "identity-shares"],
    ["grants", "#access-book/imported-reference", "access-book"],
    ["requests", "#hosted-requests/request-reference", "hosted-requests"],
    ["requests", "#local-requests/request-reference", "local-requests"],
    ["sessions", "#sent-drops", "sent-drops"],
    ["sessions", "#vault-session-existing-reference", "vault-share-sessions"],
    [
      "sessions",
      "#local-authority-templates/raid",
      "local-authority-templates",
    ],
    ["sessions", "#access-receipts/receipt-reference", "access-receipts"],
  ])("%s %s opens the one record collection", (view, hash, panel) => {
    expect(accessPanel(view, hash)).toBe(panel);
  });
  it("an unrelated hash cannot switch to a collection from another view", () => {
    expect(accessPanel("requests", "#identity-shares")).toBe("local-requests");
  });
});
