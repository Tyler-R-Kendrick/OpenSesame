import type { Meta, StoryObj } from "@storybook/react-vite";
import { EmptyTip, emptyTipKeys } from "../../src/components/EmptyTip.js";

/**
 * The quiet tip under an empty-state heading, in the same voice as field
 * guidance. A named tip is written twice, for a keyboard and for a finger,
 * and CSS shows the one that fits the pointer.
 */
const meta = {
  title: "Shell/EmptyTip",
  component: EmptyTip,
  tags: ["autodocs", "ai-generated"],
  args: { tip: "vaultEmpty" },
  argTypes: { tip: { control: "select", options: emptyTipKeys } },
} satisfies Meta<typeof EmptyTip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Every named tip, in the keyboard voice. */
export const All: Story = {
  render: () => (
    <div style={{ display: "grid", gap: 8 }}>
      {emptyTipKeys.map((tip) => (
        <EmptyTip key={tip} tip={tip} />
      ))}
    </div>
  ),
};

/** Custom words that are not about keys, so they stay on a touch pointer too. */
export const Custom: Story = {
  args: { tip: undefined, keys: false, children: "Nothing shared yet." },
};
