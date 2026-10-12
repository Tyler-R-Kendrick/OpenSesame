import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { IconKey, ReloadKey } from "../../src/components/IconKey.js";
import {
  IconCopy,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "../../src/components/Icons.js";
import { figma } from "../figma.js";

/**
 * An icon key (docs/design/controls.md § 2): an action that executes, drawn
 * as a 44px square whose sentence is its accessible name and its tooltip.
 * The verb is never painted on the face. A destructive key arms on the
 * first press and fires on the second; it is still ink, never red.
 */
const meta = {
  title: "Controls/IconKey",
  component: IconKey,
  tags: ["autodocs", "ai-generated"],
  parameters: { layout: "centered", ...figma("icon-key") },
  args: {
    label: "Add an item",
    onClick: fn(),
    children: <IconPlus size={20} />,
  },
} satisfies Meta<typeof IconKey>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The small key a panel head carries beside its title. */
export const Small: Story = {
  args: { small: true, label: "Copy", children: <IconCopy size={15} /> },
};

/** Armed: one more press fires. Inverted ink, the same square. */
export const Armed: Story = {
  args: {
    armed: true,
    label: "Delete. Press again to confirm",
    children: <IconTrash size={20} />,
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
    label: "Refresh",
    children: <IconRefresh size={20} />,
  },
};

/** The one reload every panel head shares. */
export const Reload: Story = {
  render: () => <ReloadKey label="Reload the list" onReload={fn()} />,
};
