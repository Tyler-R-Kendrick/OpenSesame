import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { IconArrowRight } from "../../src/components/Icons.js";
import type { WordmarkHandle } from "../../src/components/Wordmark.js";
import { UnlockStage } from "../../src/screens/unlock/UnlockStage.js";
import "../../src/screens/unlock.css";
import { figma } from "../figma.js";

/**
 * The lock-v5 stage every unlock gate is drawn on: the hero wordmark (decode,
 * then shimmer), the cipher dial behind the column seam with its key in
 * front, the card, and the release notes. The card here holds a stand-in for
 * the unlock form; its go key runs the ceremony the app runs on a correct
 * key: the rings align (780 ms), the index reads `0PEN — SESAME`, and the
 * doors part along the seam from 920 to 1620 ms.
 */
function Stage() {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const notesRef = useRef<HTMLElement | null>(null);
  const wordmarkRef = useRef<WordmarkHandle | null>(null);
  const [token, setToken] = useState(0);
  return (
    <UnlockStage
      paneRef={paneRef}
      cardRef={cardRef}
      notesRef={notesRef}
      wordmarkRef={wordmarkRef}
      ceremonyToken={token}
      vaultUnlocked={token > 0}
    >
      <form
        className="unlock__form"
        onSubmit={(event) => {
          event.preventDefault();
          setToken((n) => n + 1);
        }}
      >
        <div className="field">
          <label htmlFor="story-pin">PIN</label>
          <input
            id="story-pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            defaultValue="2468"
          />
        </div>
        <div className="go-row">
          <button
            type="submit"
            className="go"
            aria-label="Unlock"
            title="Unlock"
          >
            <IconArrowRight size={18} />
          </button>
          <span className="go-verb" aria-hidden="true">
            Unlock
          </span>
        </div>
      </form>
    </UnlockStage>
  );
}

const meta = {
  title: "Gates/Unlock stage",
  component: Stage,
  tags: ["ai-generated"],
  parameters: { layout: "fullscreen", ...figma("unlock") },
  decorators: [
    (Story) => (
      <div style={{ minHeight: "100dvh", display: "grid" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Stage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** At rest. Press the go key to run the ceremony; reload the story to rearm. */
export const Stage_: Story = { name: "Stage" };
