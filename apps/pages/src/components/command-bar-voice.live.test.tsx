import { resetSpeechSeams } from "@opensesame/app-core/lib/command-bar/speech.js";
// @vitest-environment jsdom
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { CommandBar } from "./CommandBar.js";
import { CommandBarVoice } from "./command-bar-voice.js";
import { installFakeSpeech } from "./command-bar-voice.test-support.js";

let release: (() => void) | null = null;

afterEach(() => {
  cleanup();
  release?.();
  release = null;
  resetSpeechSeams();
});

describe("CommandBar with voice input", () => {
  it("keeps one live push-to-talk while interim words re-render the bar", () => {
    const { engines } = installFakeSpeech(true);
    release = registerContributionForTest("command-assist", {
      id: "test-model",
      order: 0,
      interpret: async () => ({ source: "none", reason: "Empty command." }),
      Voice: CommandBarVoice,
    });
    render(
      <MemoryRouter>
        <CommandBar />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start listening" }));
    act(() => engines[0]?.hear("go to"));
    act(() => engines[0]?.hear("go to vault"));
    expect(
      screen.getByRole<HTMLInputElement>("combobox", { name: "Command" }).value,
    ).toBe("go to vault");
    expect(engines).toHaveLength(1);
    expect(engines[0]?.aborted).toBe(false);
  });
});
