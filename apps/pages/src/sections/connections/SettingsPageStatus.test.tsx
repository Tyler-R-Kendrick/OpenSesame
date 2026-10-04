import { localGitToConnection } from "@opensesame/app-core/lib/connections-local-git.js";
import type { Connection } from "@opensesame/app-core/lib/connections.js";
/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { inTray } from "../../components/tray.test-support.js";
import { AuthorizedAccount } from "./SettingsPageStatus.js";

afterEach(() => {
  cleanup();
});

function account(overrides: Partial<Connection>): Connection {
  return {
    ...localGitToConnection({
      id: "git_local_account",
      displayName: "Work forge",
      remoteUrl: "git@forge.example:team/store.git",
      authMode: "ssh_agent",
      username: null,
      secretItemId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    ...overrides,
  };
}

function mount(connection: Connection) {
  return render(
    <MemoryRouter>
      <ul>
        <AuthorizedAccount
          connection={connection}
          provider={null}
          ceremonyRoot="/settings/connections"
        />
      </ul>
    </MemoryRouter>,
  );
}

describe("AuthorizedAccount", () => {
  it("keeps a troubled account's recovery sentence on the row with its mark", () => {
    const sentence = "Renewal was refused. Authorize it again to restore it.";
    mount(account({ status: "needs_reauth", statusDetail: sentence }));

    expect(screen.getByText(sentence)).toBeTruthy();
    expect(inTray(sentence)).toBe(false);
    expect(
      screen.getByRole("link", { name: "Settings for Work forge" }),
    ).toBeTruthy();
  });

  it("keeps a healthy account's sentence on the row", () => {
    mount(account({ status: "active" }));

    expect(screen.getByText(/^Authorized as /)).toBeTruthy();
  });
});
