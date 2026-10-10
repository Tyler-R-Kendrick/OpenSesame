import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentType } from "react";
import * as Icons from "../../src/components/Icons.js";
import type { IconProps } from "../../src/components/Icons.js";

type IconEntry = [string, ComponentType<IconProps>];

/**
 * Every glyph the app draws, from `components/Icons*.tsx`: one family, one
 * stroke, drawn in `currentColor` so a glyph is ink on a key and canvas on
 * an armed one. A verb is never painted on a key; the glyph is the key.
 */
const entries: IconEntry[] = Object.entries(
  Icons as Record<string, unknown>,
).flatMap(([name, value]) =>
  name.startsWith("Icon") && typeof value === "function"
    ? [[name, value as ComponentType<IconProps>] as IconEntry]
    : [],
);

function Gallery({ size }: { size: number }) {
  return (
    <ul
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))",
        gap: 12,
        listStyle: "none",
        margin: 0,
        padding: 0,
      }}
    >
      {entries.map(([name, Icon]) => (
        <li
          key={name}
          style={{
            display: "grid",
            justifyItems: "center",
            gap: 8,
            padding: 12,
            border: "1px solid var(--line)",
            font: "11px ui-monospace, monospace",
            color: "var(--ink-2)",
          }}
        >
          <Icon size={size} title={name} />
          <span>{name.slice(4)}</span>
        </li>
      ))}
    </ul>
  );
}

const meta = {
  title: "Brand/Icons",
  component: Gallery,
  tags: ["autodocs", "ai-generated"],
  args: { size: 20 },
  argTypes: { size: { control: { type: "number", min: 12, max: 48 } } },
} satisfies Meta<typeof Gallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const All: Story = {};
