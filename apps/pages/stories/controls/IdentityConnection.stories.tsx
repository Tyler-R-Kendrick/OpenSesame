import { identityConnectionDraft } from "@opensesame/app-core/lib/identity-connections-presets.js";
import type { IdentityConnectionDraft } from "@opensesame/app-core/lib/identity-connections-schema.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import { IdentityConnectionForm } from "../../src/sections/connections/identity/IdentityConnectionForm.js";
import "../../src/sections/connections/connect/connect.css";

const meta = {
  title: "Controls/Identity connection",
  component: IdentityConnectionForm,
  tags: ["autodocs", "ai-generated"],
  parameters: { layout: "padded" },
  args: {
    draft: identityConnectionDraft("byo-identity"),
    busy: false,
    online: true,
    failure: "",
    saved: false,
    organizations: [],
    onChange: fn(),
    onSubmit: fn(),
    onTest: fn(),
    onReload: fn(),
    onLoadOrganizations: fn(),
    onConnectService: fn(),
    onSignInService: fn(),
  },
  render: function Configuration(args) {
    const [draft, setDraft] = useState(args.draft);
    return (
      <div className="cx-setup">
        <section className="panel">
          <IdentityConnectionForm
            {...args}
            draft={draft}
            onChange={(key: keyof IdentityConnectionDraft, value: string) =>
              setDraft((current) => ({ ...current, [key]: value }))
            }
          />
        </section>
      </div>
    );
  },
} satisfies Meta<typeof IdentityConnectionForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ByoOidc: Story = {};
export const BetterAuth: Story = {
  args: { draft: identityConnectionDraft("better-auth") },
};
export const Supabase: Story = {
  args: { draft: identityConnectionDraft("supabase") },
};
export const Neon: Story = {
  args: { draft: identityConnectionDraft("neon-auth") },
};
export const Clerk: Story = {
  args: { draft: identityConnectionDraft("clerk") },
};
export const ByoSaml: Story = {
  args: {
    draft: { ...identityConnectionDraft("byo-identity"), protocol: "saml" },
  },
};
export const ByoLdap: Story = {
  args: {
    draft: { ...identityConnectionDraft("byo-identity"), protocol: "ldap" },
  },
};
export const FailedSave: Story = {
  args: { failure: "Provider discovery could not be reached." },
};
