import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  double,
  installDoublePorts,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { SetupScreen } from "../SetupScreen.js";
import { DEFAULT_EXTENSIONS } from "./default-extensions.js";
import { resetSetupScreen } from "./test-harness.js";
import { createSetupSeams } from "./test-seams.js";

installDoublePorts();

const seams = createSetupSeams();
const { completeSetup } = seams;

beforeEach(() => resetSetupScreen(seams));
afterEach(cleanup);

describe("the configuration choice (ADR 0154)", () => {
  it("commits the minimal plan and finishes", async () => {
    const onDone = vi.fn();
    const before = double.commits.length;
    render(<SetupScreen onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: /^Minimal$/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const draft = double.commits.at(-1)?.draft;
    expect(double.commits).toHaveLength(before + 1);
    expect(draft?.selectedOptional).toEqual([]);
    expect(draft?.delivery).toEqual({
      prefetch: "none",
      offlineCache: "shell-only",
    });
    expect(completeSetup).toHaveBeenCalledWith({
      ways: ["builtin"],
      service: false,
      skipped: [],
    });
  });

  it("commits the default extensions and asks for them to be fetched", async () => {
    const onDone = vi.fn();
    render(<SetupScreen onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: /^Default$/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const draft = double.commits.at(-1)?.draft;
    expect(draft?.selectedOptional).toEqual([...DEFAULT_EXTENSIONS]);
    expect(draft?.delivery).toEqual({
      prefetch: "selected",
      offlineCache: "selected-only",
    });
  });

  it("stays on the choice when the commit is refused", async () => {
    const commit = double.commit.bind(double);
    let settled = false;
    double.commit = (async () => {
      settled = true;
      return {
        status: "conflict" as const,
        reason: "policy-revision" as const,
      };
    }) as typeof double.commit;
    try {
      const onDone = vi.fn();
      render(<SetupScreen onDone={onDone} />);
      fireEvent.click(screen.getByRole("button", { name: /^Default$/ }));
      await waitFor(() => expect(settled).toBe(true));
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: /^Default$/ })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
      expect(onDone).not.toHaveBeenCalled();
      expect(completeSetup).not.toHaveBeenCalled();
      expect(screen.queryByRole("tab")).toBeNull();
    } finally {
      double.commit = commit;
    }
  });

  it("records a skip without committing a configuration", async () => {
    const onDone = vi.fn();
    const before = double.commits.length;
    render(<SetupScreen onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip all" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(double.commits).toHaveLength(before);
    expect(completeSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        skipped: expect.arrayContaining(["capabilities"]),
      }),
    );
  });
});
