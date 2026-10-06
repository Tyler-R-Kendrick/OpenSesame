import { expect, it } from "vitest";
import {
  flushRetiredCredentialTelemetry,
  trackRetiredCredentialTelemetry,
} from "./telemetry-queue.js";

it("keeps a short-lived client draining until pending evidence settles", async () => {
  let finish = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const tracked = trackRetiredCredentialTelemetry(pending);
  let drained = false;
  const flush = flushRetiredCredentialTelemetry().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  finish();
  await tracked;
  await flush;
  expect(drained).toBe(true);
});

it("does not turn rejected local evidence into a failed client drain or retained pending work", async () => {
  const rejected = trackRetiredCredentialTelemetry(
    Promise.reject(new Error("Local storage unavailable")),
  );
  const observed = expect(rejected).rejects.toThrow(
    /Local storage unavailable/,
  );
  await expect(flushRetiredCredentialTelemetry()).resolves.toBeUndefined();
  await observed;
  await expect(flushRetiredCredentialTelemetry()).resolves.toBeUndefined();
});
