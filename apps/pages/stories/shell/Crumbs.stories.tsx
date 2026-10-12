import type { Meta, StoryObj } from "@storybook/react-vite";
import { CrumbTrail } from "../../src/components/Crumbs.js";

/**
 * The path above a record: links back to each ancestor and the current
 * page as plain words. One item is a label, not a path, so the shell draws
 * the trail only from two.
 */
const meta = {
  title: "Shell/Crumbs",
  component: CrumbTrail,
  tags: ["autodocs", "ai-generated"],
  args: {
    className: "crumbs",
    label: "Where you are",
    crumbs: [
      { label: "Vault", to: "/vault" },
      { label: "Work", to: "/vault?folder=work" },
      { label: "GitHub" },
    ],
  },
} satisfies Meta<typeof CrumbTrail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Settings: Story = {
  args: {
    crumbs: [{ label: "Settings", to: "/settings" }, { label: "Security" }],
  },
};
