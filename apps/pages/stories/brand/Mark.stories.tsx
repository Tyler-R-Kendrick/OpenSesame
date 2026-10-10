import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  IconConnection,
  IconMark,
  IconSite,
  IconVault,
} from "../../src/components/Icons.js";
import { figma } from "../figma.js";

/**
 * The mark is the door ajar: the vault slab slid aside and a slit of light
 * where it opened (`CipherWordmark/mark-geometry.ts`, which also holds
 * `public/icon.svg` to the same geometry). The three section glyphs are
 * the mark with a surface drawn around it.
 */
const meta = {
  title: "Brand/Mark",
  component: IconMark,
  tags: ["autodocs", "ai-generated"],
  parameters: { layout: "centered", ...figma("mark") },
  argTypes: { size: { control: { type: "number", min: 12, max: 160 } } },
} satisfies Meta<typeof IconMark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { size: 48, title: "OpenSesame" } };

/** The mark at the sizes the app draws it: the rail, a key, a tile, the door. */
export const Sizes: Story = {
  render: () => (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 24 }}>
      {[16, 20, 24, 32, 48, 96].map((size) => (
        <IconMark key={size} size={size} title={`${size}px`} />
      ))}
    </div>
  ),
};

/** The section glyphs built on the mark: vault, site, connection. */
export const Sections: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 24 }}>
      <IconVault size={32} title="Vault" />
      <IconSite size={32} title="Site" />
      <IconConnection size={32} title="Connection" />
    </div>
  ),
};
