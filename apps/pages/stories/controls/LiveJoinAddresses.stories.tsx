import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";
import {
  ALLOW_ADDRESSES,
  JOIN_WITHOUT_ADDRESSES,
  ReplyAddresses,
} from "../../src/modules/sharing.live/LiveJoinAddresses.js";
import "../../src/modules/sharing.live/live.css";

/**
 * The addresses an owner's reply names, shown to the joiner before the
 * browser checks any of them (ADR 0150 §6, amended 2026-10-24): one mono
 * row each, the `.go` key that allows them with its verb beside it, and the
 * icon key that joins without them.
 */
const meta = {
  title: "Controls/Live join addresses",
  component: ReplyAddresses,
  tags: ["autodocs", "ai-generated"],
  parameters: { layout: "padded" },
  args: { addresses: ["100.64.0.7"], onAnswer: fn() },
} satisfies Meta<typeof ReplyAddresses>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One address: a tailnet node the owner named in Routes. */
export const OneAddress: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(
      canvas.getByRole("button", { name: ALLOW_ADDRESSES }),
    );
    await expect(args.onAnswer).toHaveBeenCalledWith(true);
  },
};

/** Several: a tailnet, a LAN and this machine. */
export const Several: Story = {
  args: { addresses: ["100.64.0.7", "192.168.1.20", "127.0.0.1"] },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(
      canvas.getByRole("button", { name: JOIN_WITHOUT_ADDRESSES }),
    );
    await expect(args.onAnswer).toHaveBeenCalledWith(false);
  },
};

/** The most a reply may name: eight. */
export const Maximum: Story = {
  args: {
    addresses: Array.from({ length: 8 }, (_, at) => `100.64.0.${at + 1}`),
  },
};

/** A long IPv6 address, as canonical as the reply carries it. */
export const LongIpv6: Story = {
  args: {
    addresses: ["fd7a:115c:a1e0:ab12:4843:cd96:6258:b240", "100.101.102.103"],
  },
};
