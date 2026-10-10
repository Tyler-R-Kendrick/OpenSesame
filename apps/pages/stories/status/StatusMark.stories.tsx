import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { StatusMark } from "../../src/components/StatusMark.js";
import { figma } from "../figma.js";

/**
 * A status is a glyph, never a text pill and never a hue: ok, warn, err and
 * idle differ by shape and by shade (docs/design/color-vision.md). The label
 * is the accessible name and the tooltip; on a touch pointer a tap opens
 * the same words in a bubble.
 */
const meta = {
  title: "Status/StatusMark",
  component: StatusMark,
  tags: ["autodocs", "ai-generated"],
  parameters: { layout: "centered", ...figma("status-mark") },
  args: { tone: "ok", label: "Synced" },
  argTypes: {
    tone: { control: "radio", options: ["ok", "warn", "err", "idle"] },
  },
} satisfies Meta<typeof StatusMark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ok: Story = {};
export const Warn: Story = { args: { tone: "warn", label: "Expires soon" } };
export const Err: Story = { args: { tone: "err", label: "Could not sync" } };
export const Idle: Story = { args: { tone: "idle", label: "Locked" } };

/** The four tones in a row, as a list reads them. */
export const Tones: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 24 }}>
      <StatusMark tone="ok" label="Synced" />
      <StatusMark tone="warn" label="Expires soon" />
      <StatusMark tone="err" label="Could not sync" />
      <StatusMark tone="idle" label="Locked" />
    </div>
  ),
};

/**
 * The greyscale contract, measured: the err tone's ink is a grey (R = G = B),
 * and the mark has square corners. This story fails if a hue or a radius
 * ever reaches a status.
 */
export const CssCheck: Story = {
  args: { tone: "err", label: "Could not sync" },
  play: async ({ canvas }) => {
    const mark = canvas.getByRole("img", { name: "Could not sync" });
    const style = getComputedStyle(mark);
    const [r, g, b] = style.color.match(/\d+/g)?.map(Number) ?? [];
    await expect(r).toBe(g);
    await expect(g).toBe(b);
    await expect(style.borderRadius).toBe("0px");
  },
};
