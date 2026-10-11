/**
 * The edits environments make to a vault body (ADR 0194): each is validated
 * against the body it lands on, and an edit that does not fit throws.
 */

import { environmentNames } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { applyEnvironmentsEdit } from "./body-environments.js";
import { edit, item, vault } from "./environments.test-support.js";

describe("the edits", () => {
  it("add an environment once and refuse a name that cannot be one", () => {
    const body = vault([]);
    edit(
      body,
      { op: "add-environment", name: "staging" },
      { op: "add-environment", name: "staging" },
    );
    expect(environmentNames(body.environments)).toEqual(["staging"]);
    expect(() =>
      applyEnvironmentsEdit(body, { op: "add-environment", name: "Not Valid" }),
    ).toThrow(/lower-case/);
  });

  it("set and clear a value and a rule, leaving no empty field behind", () => {
    const body = vault([item("a", "Token")], "production");
    edit(
      body,
      { op: "add-key", itemId: "a" },
      {
        op: "set-cell",
        itemId: "a",
        environment: "production",
        cell: { value: "v", required: true },
      },
    );
    expect(body.items[0]?.environments).toEqual({
      production: { value: "v", required: true },
    });
    edit(body, {
      op: "set-cell",
      itemId: "a",
      environment: "production",
      cell: { value: "", required: false },
    });
    expect(body.items[0]?.environments).toEqual({ production: {} });
  });

  it("leave the other field alone when only one is given", () => {
    const body = vault([item("a", "Token")], "production");
    edit(
      body,
      { op: "add-key", itemId: "a" },
      {
        op: "set-cell",
        itemId: "a",
        environment: "production",
        cell: { value: "v" },
      },
      {
        op: "set-cell",
        itemId: "a",
        environment: "production",
        cell: { required: true },
      },
    );
    expect(body.items[0]?.environments).toEqual({
      production: { value: "v", required: true },
    });
  });

  it("refuse a cell for an environment that does not exist or an item that is not a key", () => {
    const body = vault([item("a", "Token")], "production");
    expect(() =>
      applyEnvironmentsEdit(body, {
        op: "set-cell",
        itemId: "a",
        environment: "production",
        cell: { value: "v" },
      }),
    ).toThrow(/not a key/);
    edit(body, { op: "add-key", itemId: "a" });
    expect(() =>
      applyEnvironmentsEdit(body, {
        op: "set-cell",
        itemId: "a",
        environment: "staging",
        cell: { value: "v" },
      }),
    ).toThrow(/no environment called staging/);
    expect(() =>
      applyEnvironmentsEdit(body, { op: "add-key", itemId: "gone" }),
    ).toThrow(/not in this vault/);
  });

  it("take an item out of the schema with every value it held", () => {
    const body = vault([item("a", "Token")], "production");
    edit(
      body,
      { op: "add-key", itemId: "a" },
      {
        op: "set-cell",
        itemId: "a",
        environment: "production",
        cell: { value: "v" },
      },
      { op: "remove-key", itemId: "a" },
    );
    expect("environments" in (body.items[0] ?? {})).toBe(false);
  });

  it("remove an environment with its values from every key, in the same write", () => {
    const body = vault(
      [item("a", "Token"), item("b", "Url")],
      "staging",
      "production",
    );
    edit(
      body,
      { op: "add-key", itemId: "a" },
      { op: "add-key", itemId: "b" },
      {
        op: "set-cell",
        itemId: "a",
        environment: "staging",
        cell: { value: "stage" },
      },
      {
        op: "set-cell",
        itemId: "a",
        environment: "production",
        cell: { value: "prod" },
      },
      { op: "remove-environment", name: "staging" },
    );
    expect(environmentNames(body.environments)).toEqual(["production"]);
    expect(body.environments?.staging?.removed).toBe(true);
    expect(body.items.find((entry) => entry.id === "a")?.environments).toEqual({
      production: { value: "prod" },
    });
    // The key stays a key even with nothing left in it.
    expect(body.items.find((entry) => entry.id === "b")?.environments).toEqual(
      {},
    );
  });
});
