import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { FrontDoor } from "../../src/screens/FrontDoor.js";
import { figma } from "../figma.js";

/**
 * The front door: the first screen of a device with no vault (ADR 0115,
 * ADR 0150 §1). The wordmark at hero scale decodes from the cipher, one slot
 * at a time under the cursor, then keeps its particle shimmer; behind the
 * card the cipher dial idles, its key (index and readout) drawn in front of
 * the card and the release notes. Two roads, Set up your own and Join a
 * session, and the guest Skip in the card's corner (AGENTS.md §5).
 */
const meta = {
  title: "Gates/Front door",
  component: FrontDoor,
  tags: ["ai-generated"],
  parameters: { layout: "fullscreen", ...figma("front-door") },
  args: { onOpenSetup: fn(), onOpenJoin: fn() },
  decorators: [
    (Story) => (
      <div style={{ minHeight: "100dvh", display: "grid" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FrontDoor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Door: Story = {};
