import type { Meta, StoryObj } from "@storybook/react-vite";
import { Wordmark } from "../../src/components/Wordmark.js";
import { figma } from "../figma.js";

/**
 * The brand line (lock-v5): "0PEN SESAME" punched out of particle plates on a
 * canvas. Each plate decrypts from a hex cipher, one slot after another, its
 * dots shimmering until the name settles. `replay` runs the decrypt again on
 * mount (the unlock gate does), and `includeMark` draws the slab and slit
 * mark at plate height in front of the name, as the unlock hero does.
 */
const meta = {
  title: "Brand/Wordmark",
  component: Wordmark,
  tags: ["autodocs", "ai-generated"],
  parameters: { layout: "centered", ...figma("wordmark") },
  argTypes: {
    size: { control: { type: "number", min: 10, max: 120, step: 1 } },
    as: { control: "radio", options: ["p", "h1"] },
  },
} satisfies Meta<typeof Wordmark>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The unlock gate's hero: the mark and the name, decrypting on mount. */
export const UnlockHero: Story = {
  args: { size: 89, includeMark: true, replay: true },
};

/** The front door's title, as the page's `h1`. */
export const FrontDoor: Story = {
  args: { size: 48, as: "h1", replay: true },
};

/** The rail's wordmark at chrome size. */
export const Rail: Story = {
  args: { size: 14, replay: true },
};
