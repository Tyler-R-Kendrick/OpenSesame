import {
  createItem,
  manualPassword,
  splitAccount,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { hideableItems } from "./items-text.js";

describe("hideableItems", () => {
  it("does not count a bound password as its own hideable row", () => {
    const at = "2026-09-01T00:00:00.000Z";
    const draft = {
      ...createItem("account", "Billing"),
      id: "acct",
      methods: [manualPassword("acct:p", "secret", at)],
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
    const items = splitAccount([], draft, at);
    expect(hideableItems(items).map((item) => item.id)).toEqual(["acct"]);
  });
});
