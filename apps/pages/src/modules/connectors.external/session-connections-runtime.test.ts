/**
 * External connectors lends the app's connections to a live session while it
 * is active, and takes the lending back when it is not (ADR 0196).
 */
import { connectionPort } from "@opensesame/app-core/lib/live/connection-port.js";
/** @vitest-environment jsdom */
import { afterEach as afterGenuine, beforeEach as beforeGenuine } from "vitest";
import { afterEach, describe, expect, it } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import {
  closeGenuineRuntimeFixture,
  genuineRuntimeFixture,
} from "./genuine-runtime.test-support.js";
import { bindProviderRuntime } from "./native-runtime.js";
import { bindSessionConnections } from "./session-connections-runtime.js";

const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
});

describe("the session connection port", () => {
  it("is bound while the capability is active, and gone when it is disposed", () => {
    expect(connectionPort()).toBeNull();
    const { ctx } = createTestContext();
    const activation = createActivation(ctx, "connectors.external");
    releases.push(activation.dispose);
    bindSessionConnections(activation);
    expect(connectionPort()).not.toBeNull();
    expect(connectionPort()?.list()).toEqual([]);
    activation.dispose();
    expect(connectionPort()).toBeNull();
  });

  it("is part of what the provider runtime binds", () => {
    const { ctx } = createTestContext();
    const activation = createActivation(ctx, "connectors.external");
    releases.push(activation.dispose);
    bindProviderRuntime(ctx, activation);
    expect(connectionPort()).not.toBeNull();
    activation.dispose();
    expect(connectionPort()).toBeNull();
  });

  it("belongs to the activation that made it: a newer one is not released by an older", () => {
    const first = createTestContext();
    const second = createTestContext();
    const older = createActivation(first.ctx, "connectors.external");
    const newer = createActivation(second.ctx, "connectors.external");
    releases.push(older.dispose, newer.dispose);
    bindSessionConnections(older);
    const theirs = connectionPort();
    bindSessionConnections(newer);
    expect(connectionPort()).not.toBe(theirs);
    older.dispose();
    expect(connectionPort()).not.toBeNull();
    newer.dispose();
    expect(connectionPort()).toBeNull();
  });
});

beforeGenuine(genuineRuntimeFixture);
afterGenuine(closeGenuineRuntimeFixture);
