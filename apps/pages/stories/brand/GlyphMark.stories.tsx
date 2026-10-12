import type { Meta, StoryObj } from "@storybook/react-vite";
import { GlyphMark } from "../../src/components/GlyphMark.js";

/**
 * The identicon: an 8×8 dot glyph derived from a stable id, one per vault,
 * person or organization, so two things with the same name still read
 * apart. It is the one place a hue survives in the app, and only as a
 * derived identity, never as a status.
 */
const meta = {
  title: "Brand/GlyphMark",
  component: GlyphMark,
  tags: ["autodocs", "ai-generated"],
  parameters: { layout: "centered" },
  args: { kind: "vault", id: "personal" },
  argTypes: { kind: { control: "radio", options: ["vault", "person", "org"] } },
} satisfies Meta<typeof GlyphMark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Vault: Story = {};
export const Person: Story = {
  args: { kind: "person", id: "ada@example.org" },
};
export const Org: Story = { args: { kind: "org", id: "acme" } };

/** Six vaults side by side: every id its own glyph. */
export const Several: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 16 }}>
      {["personal", "work", "guest", "project · 4f2a", "shared", "travel"].map(
        (id) => (
          <GlyphMark key={id} kind="vault" id={id} />
        ),
      )}
    </div>
  ),
};
