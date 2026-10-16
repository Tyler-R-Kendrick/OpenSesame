import {
  secretBackendDraft,
  secretBackendPreset,
} from "@opensesame/app-core/lib/secret-backends/presets.js";
import type { SecretBackendDraft } from "@opensesame/app-core/lib/secret-backends/types.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import { SecretBackendFileFields } from "../../src/sections/connections/secret-backends/SecretBackendFileFields.js";
import { SecretBackendForm } from "../../src/sections/connections/secret-backends/SecretBackendForm.js";
import "../../src/sections/connections/connect/connect.css";

const preset = secretBackendPreset("byo-secret-backend");
if (!preset) throw new Error("BYO secret backend preset is missing");
const meta = {
  title: "Controls/Secret backend",
  component: SecretBackendForm,
  tags: ["autodocs", "ai-generated"],
  parameters: { layout: "padded" },
  args: {
    draft: secretBackendDraft("byo-secret-backend"),
    modes: preset.modes,
    docsUrl: preset.docsUrl,
    setup: preset.setup,
    busy: false,
    online: true,
    saved: false,
    failure: "",
    onChange: fn(),
    onSubmit: fn(),
    onProbe: fn(),
    onReload: fn(),
  },
  render: function Configuration(args) {
    const [draft, setDraft] = useState(args.draft);
    const [file, setFile] = useState<File | null>(null);
    const [password, setPassword] = useState("");
    const current = secretBackendPreset(draft.providerId);
    const changed = (key: keyof SecretBackendDraft, value: string) =>
      setDraft((previous) => ({ ...previous, [key]: value }));
    return (
      <div className="cx-setup">
        <section className="panel">
          <SecretBackendForm
            {...args}
            draft={draft}
            modes={current?.modes ?? args.modes}
            setup={current?.setup}
            docsUrl={current?.docsUrl}
            onChange={changed}
          >
            {draft.mode === "file-import" ? (
              <SecretBackendFileFields
                draft={draft}
                busy={args.busy}
                onChange={changed}
                formats={current?.fileFormats ?? []}
                file={file}
                password={password}
                onFile={setFile}
                onPassword={setPassword}
              />
            ) : null}
          </SecretBackendForm>
        </section>
      </div>
    );
  },
} satisfies Meta<typeof SecretBackendForm>;
export default meta;
type Story = StoryObj<typeof meta>;
export const LocalVault: Story = {};
export const OnePasswordConnect: Story = {
  args: {
    draft: { ...secretBackendDraft("1password"), mode: "onepassword-connect" },
  },
};
export const Bitwarden: Story = {
  args: {
    draft: { ...secretBackendDraft("bitwarden"), mode: "bitwarden-api" },
  },
};
export const BitwardenSecrets: Story = {
  args: { draft: secretBackendDraft("bitwarden-sm") },
};
export const Infisical: Story = {
  args: { draft: secretBackendDraft("infisical") },
};
export const Passwordstate: Story = {
  args: { draft: secretBackendDraft("passwordstate") },
};
export const BrowserCredentials: Story = {
  args: { draft: secretBackendDraft("browser-credentials") },
};
export const ProtonPassImport: Story = {
  args: { draft: secretBackendDraft("proton-pass") },
};
export const FailedProbe: Story = {
  args: { failure: "The configured endpoint refused this credential." },
};
