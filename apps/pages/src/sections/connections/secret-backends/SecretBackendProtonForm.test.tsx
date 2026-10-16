/** @vitest-environment jsdom */
import {
  secretBackendDraft,
  secretBackendPreset,
} from "@opensesame/app-core/lib/secret-backends/presets.js";
import type { SecretBackendDraft } from "@opensesame/app-core/lib/secret-backends/types.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SecretBackendForm } from "./SecretBackendForm.js";

afterEach(cleanup);
function Form({
  providerId,
  save,
}: { providerId: string; save: (draft: SecretBackendDraft) => void }) {
  const [draft, setDraft] = useState(() => secretBackendDraft(providerId));
  const preset = secretBackendPreset(providerId);
  if (!preset) throw new Error("Missing common provider preset");
  return (
    <SecretBackendForm
      draft={draft}
      busy={false}
      saved={false}
      online
      failure=""
      modes={preset.modes}
      onChange={(key, value) =>
        setDraft((previous) => ({ ...previous, [key]: value }))
      }
      onSubmit={(event) => {
        event.preventDefault();
        save(draft);
      }}
      onProbe={() => save(draft)}
      onReload={() => {}}
    />
  );
}

it.each(["proton-pass", "byo-secret-backend"])(
  "%s composes actual native endpoint, scoped token and public version controls",
  async (providerId) => {
    const save = vi.fn<(draft: SecretBackendDraft) => void>();
    const user = userEvent.setup();
    render(<Form providerId={providerId} save={save} />);
    expect(secretBackendDraft(providerId).appVersion).toBe(
      providerId === "proton-pass" ? "cli-pass@2.4.2" : undefined,
    );
    await user.selectOptions(
      screen.getByLabelText("Connection method"),
      "proton-pass",
    );
    expect(screen.getByLabelText("Personal access token")).toHaveProperty(
      "type",
      "password",
    );
    expect(
      screen.getByLabelText("Accepted application/version header"),
    ).toHaveProperty("type", "text");
    await user.type(
      screen.getByLabelText("API base URL"),
      "https://pass-api.proton.me/api",
    );
    await user.type(
      screen.getByLabelText("Personal access token"),
      "public-synthetic-scoped-token",
    );
    await user.type(
      screen.getByLabelText("PAT-scoped share ID"),
      "scoped-share",
    );
    expect(
      screen.getByLabelText("Accepted application/version header"),
    ).toHaveProperty("value", "cli-pass@2.4.2");
    await user.clear(
      screen.getByLabelText("Accepted application/version header"),
    );
    await user.type(
      screen.getByLabelText("Accepted application/version header"),
      "web-opensesame@2.0.0",
    );
    await user.click(
      screen.getByRole("button", { name: "Save secret backend" }),
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "proton-pass",
        baseUrl: "https://pass-api.proton.me/api",
        token: "public-synthetic-scoped-token",
        vaultId: "scoped-share",
        appVersion: "web-opensesame@2.0.0",
        clientId: "",
      }),
    );
  },
);

it("leaves legacy and unselected BYO application headers absent", () => {
  for (const id of [
    "byo-secret-backend",
    "1password",
    "bitwarden",
    "infisical",
    "passwordstate",
  ])
    expect(secretBackendDraft(id)).not.toHaveProperty("appVersion");
});
