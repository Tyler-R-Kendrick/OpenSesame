import { describe, expect, it } from "vitest";
import { readDeviceMessage } from "./device-messages.js";
import {
  type ResetAction,
  type ResetRequestDetails,
  readDeviceResetMessage,
  resetRequestDigest,
} from "./device-reset-messages.js";

const details: ResetRequestDetails & { actions: ResetAction[] } = {
  origin: "https://accounts.example.test",
  item: "metadata",
  runtime: "agent-browser",
  model: "decision-model",
  expiresAt: 1_800_000_060_000,
  actions: ["password_reset.domain_metadata.list"],
};

describe("password reset wire", () => {
  it("requires one exact action per request and binds metadata to its sentinel", async () => {
    const digest = await resetRequestDigest(details);
    expect(
      readDeviceMessage("dev.reset", { req: "r1", ...details, digest }),
    ).toMatchObject({ t: "dev.reset", actions: details.actions });
    expect(
      readDeviceMessage("dev.reset", {
        req: "r2",
        ...details,
        actions: [...details.actions, "password_reset.item.use"],
        digest,
      }),
    ).toBeNull();
    expect(
      readDeviceMessage("dev.reset", {
        req: "r3",
        ...details,
        item: "item-1",
        digest,
      }),
    ).toBeNull();
    expect(
      readDeviceMessage("dev.reset", {
        req: "r4",
        ...details,
        digest,
        apiKey: "canary",
      }),
    ).toBeNull();
  });

  it("admits bounded metadata replies but rejects secret or unknown fields", () => {
    const grant = {
      req: "r1",
      grant: "reset-r1",
      ...details,
      digest: `sha256:${"a".repeat(64)}`,
      items: [{ id: "item-1", name: "Account", origins: [details.origin] }],
    };
    const item = grant.items[0];
    if (!item) throw new Error("Metadata fixture requires an item");
    expect(readDeviceResetMessage("dev.reset.grant", grant)).toMatchObject({
      t: "dev.reset.grant",
      items: grant.items,
    });
    expect(
      readDeviceResetMessage("dev.reset.grant", {
        ...grant,
        items: [{ ...item, username: "person@example.test" }],
      }),
    ).toBeNull();
    expect(
      readDeviceResetMessage("dev.reset.grant", { ...grant, pepper: "canary" }),
    ).toBeNull();
    expect(
      readDeviceResetMessage("dev.reset.grant", {
        ...grant,
        item: "item-1",
        actions: ["password_reset.item.use"],
      }),
    ).toBeNull();
  });
});
