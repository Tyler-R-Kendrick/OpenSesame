import type { Meta, StoryObj } from "@storybook/react-vite";
import { Wordmark } from "../../src/components/Wordmark.js";
import { figma } from "../figma.js";

/**
 * The brand line: the mark and the name punched out of ink plates on the
 * canvas. Three size tiers draw it (`CipherWordmark/particles-model.ts`):
 * letters under 16px (the rail), solid plates 16–48px (the unlock card),
 * and the particle field from 48px up (the front door's title).
 * The decrypt runs once per session; `replay` runs it again on mount.
 */
const meta = {
  title: "Brand/Wordmark",
  component: Wordmark,
  tags: ["autodocs", "ai-generated"],
  parameters: { layout: "centered", ...figma("wordmark") },
  argTypes: {
    size: { control: { type: "number", min: 10, max: 80, step: 1 } },
    as: { control: "radio", options: ["p", "h1"] },
  },
} satisfies Meta<typeof Wordmark>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The rail's wordmark at 12px: letters in ink on the plate grid. */
export const Letters: Story = {
  args: { size: 12, replay: true },
};

/** The unlock card's wordmark: solid plates at 24px, replayed on mount. */
export const Solid: Story = {
  args: { size: 24, replay: true },
};

/** The front door's title: the particle field at 62px, as the page's `h1`. */
export const Field: Story = {
  args: { size: 62, as: "h1", replay: true },
};

/** Fitted to its column instead of a fixed em (the door's card at 390). */
export const Fitted: Story = {
  args: { fit: { max: 45 }, as: "h1", replay: true },
  decorators: [
    (Story) => (
      <div style={{ width: 350 }}>
        <Story />
      </div>
    ),
  ],
};
