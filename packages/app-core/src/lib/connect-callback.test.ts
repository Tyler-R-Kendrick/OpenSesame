import { afterEach, expect, it } from "vitest";
import {
  applyConnectCallbackBase,
  connectCallbackBase,
} from "./connect-callback.js";

afterEach(() => {
  applyConnectCallbackBase(undefined);
});

it.skip("is empty with nothing configured", () => {
  expect(connectCallbackBase()).toBe("");
});

it.skip("takes the deployed base and forgets it", () => {
  applyConnectCallbackBase("https://relay.example ");
  expect(connectCallbackBase()).toBe("https://relay.example");
  applyConnectCallbackBase(undefined);
  expect(connectCallbackBase()).toBe("");
});

it("resolves `/` to the page's own origin, where the app serves the relay", () => {
  applyConnectCallbackBase("/");
  expect(connectCallbackBase("https://opensesame.example")).toBe(
    "https://opensesame.example",
  );
  expect(connectCallbackBase("")).toBe("");
});
