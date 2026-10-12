import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";
import { FormCommit } from "../../src/components/FormCommit.js";
import { IconKey } from "../../src/components/IconKey.js";
import { IconExternal } from "../../src/components/Icons.js";
import { IconX } from "../../src/components/Icons.js";
import { figma } from "../figma.js";

/**
 * The key that commits a form of several fields: the `.go` square with its
 * verb beside it in the margin voice (docs/design/controls.md § 1). The
 * same object ends every form; a phone reads what it does without a long
 * press. `children` are the form's other keys, riding the same row.
 */
const meta = {
  title: "Controls/FormCommit",
  component: FormCommit,
  tags: ["autodocs", "ai-generated"],
  parameters: { layout: "centered", ...figma("form-commit") },
  args: { label: "Save", onClick: fn() },
} satisfies Meta<typeof FormCommit>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Busy: Story = { args: { busy: true } };

/** Disabled with its reason spoken, never drawn as page copy. */
export const DisabledWithReason: Story = {
  args: { disabled: true, disabledReason: "Name the item first" },
  play: async ({ canvas }) => {
    const key = canvas.getByRole("button", { name: /Name the item first/ });
    await expect(key).toBeDisabled();
  },
};

/** A commit that opens a provider's own page rather than submitting. */
export const Opens: Story = {
  args: { label: "Open", icon: <IconExternal size={18} /> },
};

/** With the form's other keys on the same row. */
export const WithKeys: Story = {
  args: { label: "Save" },
  render: (args) => (
    <FormCommit {...args}>
      <IconKey label="Discard" onClick={fn()}>
        <IconX size={20} />
      </IconKey>
    </FormCommit>
  ),
};
