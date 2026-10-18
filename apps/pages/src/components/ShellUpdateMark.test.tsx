import {
  publish,
  resetWorkerController,
} from "@opensesame/app-core/lib/capabilities/worker/state.js";
/** @vitest-environment jsdom */
import { resetConnectivityMonitorForTests } from "@opensesame/app-core/lib/connectivity-monitor.js";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ShellUpdateMark } from "./ShellUpdateMark.js";

afterEach(() => {
  cleanup();
  resetWorkerController();
  resetConnectivityMonitorForTests();
});

describe("ShellUpdateMark", () => {
  it("is absent while online and no release is waiting", () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => true,
    });
    resetConnectivityMonitorForTests();
    render(<ShellUpdateMark />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("names a waiting release", () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => true,
    });
    resetConnectivityMonitorForTests();
    publish({ updateReady: true });
    render(<ShellUpdateMark />);
    expect(
      screen.getByRole("img", {
        name: "Update ready — Save, then reload",
      }),
    ).toBeTruthy();
  });
});
