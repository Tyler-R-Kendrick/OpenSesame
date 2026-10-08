import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FIXTURE_CATALOG } from "@opensesame/app-core/lib/configuration/doubles/composition-fixture.js";
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

/** Every optional root the fixture catalog ships, as Full selects. */
const OPTIONAL_IDS = FIXTURE_CATALOG.capabilities
  .filter((entry) => entry.tier === "optional")
  .map((entry) => entry.id)
  .sort();

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

  it("commits every optional root for the full configuration", async () => {
    const onDone = vi.fn();
    const before = double.commits.length;
    render(<SetupScreen onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: /^Full$/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const draft = double.commits.at(-1)?.draft;
    expect(double.commits).toHaveLength(before + 1);
    expect(draft?.selectedOptional).toEqual(OPTIONAL_IDS);
    // Household sharing carries the catalog's one alternative slot:
    // an unanswered slot would resolve the root out of the plan
    // (`ALTERNATIVE_NOT_CHOSEN`), so Full answers it here.
    expect(draft?.chosenAlternatives).toEqual({ transport: "sharing.drops" });
    expect(draft?.delivery).toEqual({
      prefetch: "selected",
      offlineCache: "selected-only",
    });
  });

  it("describes custom as picking capabilities, apart from full", () => {
    render(<SetupScreen onDone={vi.fn()} />);
    expect(screen.getByText("pick individual capabilities")).toBeTruthy();
    expect(screen.getByText("everything enabled")).toBeTruthy();
    expect(screen.queryByText("the full setup")).toBeNull();
  });

  it("walks the configuration choices with the arrow keys", () => {
    const onDone = vi.fn();
    render(<SetupScreen onDone={onDone} />);
    const minimal = screen.getByRole("button", { name: /^Minimal$/ });
    expect(document.activeElement).toBe(minimal);
    fireEvent.keyDown(minimal, { key: "ArrowRight" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /^Default$/ }),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: /^Default$/ }), {
      key: "ArrowRight",
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /^Full$/ }),
    );
    // End wraps to Custom; Left walks back.
    fireEvent.keyDown(screen.getByRole("button", { name: /^Full$/ }), {
      key: "End",
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /^Custom$/ }),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: /^Custom$/ }), {
      key: "ArrowLeft",
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /^Full$/ }),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: /^Full$/ }), {
      key: "Home",
    });
    expect(document.activeElement).toBe(minimal);
    // Moving focus never commits anything.
    expect(onDone).not.toHaveBeenCalled();
    expect(double.commits).toHaveLength(0);
  });

  it("stays on the choice when the commit is refused", async () => {
    const commit = double.commit.bind(double);
    let settled = false;
    const refuse: typeof double.commit = async () => {
      settled = true;
      return {
        status: "conflict",
        reason: "policy-revision",
      };
    };
    double.commit = refuse;
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
