import { unlockMethodsSeams } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Decorator } from "@storybook/react-vite";
import { vaultHooksSeams } from "../../src/lib/vault/hooks.js";
import { CliAuthorizeSheet } from "../../src/modules/cli.app-integration/CliAuthorizeSheet.js";

const store = {
  getSnapshot: () => ({ header: {}, status: "unlocked" }),
  noteFailedUnlock: () => {},
  assertMatchesOpenVaultKey: async () => {},
};

const withSeams: Decorator = (Story) => {
  Object.assign(vaultHooksSeams, { useVaultStore: () => store });
  Object.assign(unlockMethodsSeams, {
    listAvailableUnlockMethods: () => ["pin"],
  });
  return <Story />;
};

const meta = {
  title: "Modules/CliAuthorizeSheet",
  component: CliAuthorizeSheet,
  decorators: [withSeams],
  parameters: { layout: "fullscreen" },
  args: {
    request: {
      requestId: "clr_evidence",
      terminalSessionId: "tty-evidence",
      verb: "read",
      reference: "op://Personal/login/password",
      createdAtMs: 0,
    },
    onClose: () => {},
    onSettled: () => {},
  },
} satisfies Meta<typeof CliAuthorizeSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
