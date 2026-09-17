/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installViewSeams } from "../lib/use-install.js";
import { InstallMark } from "./InstallMark.js";

const original = { ...installViewSeams };

afterEach(() => {
  cleanup();
  Object.assign(installViewSeams, original);
});

describe("InstallMark", () => {
  it("sits next to the wordmark when Chromium can prompt", () => {
    Object.assign(installViewSeams, {
      state: "prompt",
      persisted: false,
      install: async () => "accepted" as const,
    });
    render(<InstallMark />);
    expect(
      screen.getByRole("button", { name: "Install OpenSesame" }),
    ).toBeTruthy();
  });

  it("withholds the control once the app is installed", () => {
    Object.assign(installViewSeams, {
      state: "installed",
      persisted: true,
      install: async () => "accepted" as const,
    });
    render(<InstallMark />);
    expect(
      screen.queryByRole("button", { name: "Install OpenSesame" }),
    ).toBeNull();
  });

  it("opens the browser dialog from the gesture", () => {
    const calls: string[] = [];
    Object.assign(installViewSeams, {
      state: "prompt",
      persisted: false,
      install: async () => {
        calls.push("prompt");
        return "accepted" as const;
      },
    });
    render(<InstallMark />);
    fireEvent.click(screen.getByRole("button", { name: "Install OpenSesame" }));
    expect(calls).toEqual(["prompt"]);
  });
});
