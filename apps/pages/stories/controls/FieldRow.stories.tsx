import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { FieldRow } from "../../src/components/FieldRow.js";
import { IconKey } from "../../src/components/IconKey.js";
import { IconCopy, IconEye } from "../../src/components/Icons.js";
import { StatusMark } from "../../src/components/StatusMark.js";
import { figma } from "../figma.js";

/**
 * A read row in a record (`.frow`): the label in the margin voice above
 * the value, and the row's keys at its end. A concealed value is dots until
 * the eye key reveals it; a status is a mark on the row, never a pill.
 */
const meta = {
  title: "Controls/FieldRow",
  component: FieldRow,
  tags: ["autodocs", "ai-generated"],
  parameters: { ...figma("field-row") },
  args: { label: "Username", children: "ada@example.org" },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 520 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FieldRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** A value with its keys: copy and reveal. */
export const WithActions: Story = {
  args: {
    label: "Password",
    children: "••••••••••••",
    actions: (
      <>
        <IconKey small label="Reveal" onClick={fn()}>
          <IconEye size={15} />
        </IconKey>
        <IconKey small label="Copy" onClick={fn()}>
          <IconCopy size={15} />
        </IconKey>
      </>
    ),
  },
};

/** A status on the row: the mark, never a text pill. */
export const WithStatus: Story = {
  args: {
    label: "Certificate",
    children: (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        expires 2026-11-02 <StatusMark tone="warn" label="Expires in 23 days" />
      </span>
    ),
  },
};
