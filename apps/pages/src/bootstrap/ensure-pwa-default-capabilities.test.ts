/** @vitest-environment jsdom */
import { PWA_DEFAULT_OPTIONALS } from "@opensesame/app-core/lib/capabilities/pwa-defaults.js";
import {
  double,
  installDoublePorts,
  resetDouble,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import { beforeEach, describe, expect, it } from "vitest";
import { ensurePwaDefaultCapabilities } from "./ensure-pwa-default-capabilities.js";

installDoublePorts();

beforeEach(() => {
  resetDouble({ selection: null, provenance: "personal-local" });
});

describe("ensurePwaDefaultCapabilities", () => {
  it("commits Access and browser-local IAM when nothing is persisted", async () => {
    expect(capabilityPorts.compositionStore.getSnapshot().selection).toBeNull();
    await ensurePwaDefaultCapabilities();
    const selection = capabilityPorts.compositionStore.getSnapshot().selection;
    expect(selection?.selectedOptional).toEqual([...PWA_DEFAULT_OPTIONALS]);
    expect(selection?.delivery).toEqual({
      prefetch: "selected",
      offlineCache: "selected-only",
    });
    expect(double.commits).toHaveLength(1);
  });

  it("does nothing when a selection already exists", async () => {
    await ensurePwaDefaultCapabilities();
    const before = double.commits.length;
    await ensurePwaDefaultCapabilities();
    expect(double.commits).toHaveLength(before);
  });
});
