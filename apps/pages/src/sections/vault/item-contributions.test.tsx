/** @vitest-environment jsdom */
import { resetContributionsForTest } from "@opensesame/app-core/lib/contributions.js";
import { dropSeams } from "@opensesame/app-core/lib/vault/drop.js";
import { createItem } from "@opensesame/vault-core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { activateForTest } from "../../modules/runtime-test-kit.js";
import * as drops from "../../modules/sharing.drops/runtime.js";
import * as localAi from "../../modules/support.local-ai/runtime.js";
import {
  KindRecord,
  SecretShares,
  useEditorContributions,
} from "./item-contributions.js";

function Suggestions() {
  const { Suggestions: Drawn } = useEditorContributions("login");
  return Drawn ? <Drawn typeId="login" onApply={() => {}} /> : null;
}

function DropForm() {
  const { Create } = useEditorContributions("drop");
  return Create ? <Create initialName="Deploy token" /> : null;
}

function draw(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

const secret = { ...createItem("secret", "API key"), value: "s3cr3t" };

afterEach(() => {
  cleanup();
  resetContributionsForTest();
});

describe("what the vault's item pages draw from other capabilities", () => {
  it("draws no drop surface and no model suggestion while neither is on", () => {
    const { container } = draw(
      <>
        <SecretShares item={secret} open onClose={() => {}} />
        <DropForm />
        <Suggestions />
      </>,
    );
    expect(container.textContent).toBe("");
  });

  it("draws the share ceremony once sharing.drops is on and it is open, and no drop form", async () => {
    const revoke = await activateForTest(drops);
    const { rerender } = draw(
      <>
        <SecretShares item={secret} open={false} onClose={() => {}} />
        <DropForm />
      </>,
    );
    // Closed, it draws nothing: the key lives in the item's toolbar.
    expect(screen.queryByRole("heading", { name: "Share once" })).toBeNull();
    rerender(
      <MemoryRouter>
        <SecretShares item={secret} open onClose={() => {}} />
        <DropForm />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Share once" })).toBeTruthy();
    expect(screen.queryByDisplayValue("Deploy token")).toBeNull();
    revoke();
  });

  it("draws a drop record only through the drop kind's own view", async () => {
    const seams = { ...vaultHooksSeams };
    const poll = dropSeams.pollClaim;
    Object.assign(vaultHooksSeams, {
      useVaultStore: () => ({ purgeItem: vi.fn(async () => {}) }),
    });
    Object.assign(dropSeams, { pollClaim: vi.fn(async () => "pending") });
    const record = {
      ...createItem("drop", "Deploy token"),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    const off = draw(<KindRecord item={record} />);
    expect(off.container.textContent).toBe("");
    cleanup();
    const revoke = await activateForTest(drops);
    const on = draw(<KindRecord item={record} />);
    expect(on.container.textContent).not.toBe("");
    revoke();
    Object.assign(vaultHooksSeams, seams);
    Object.assign(dropSeams, { pollClaim: poll });
  });

  it("draws model suggestions once support.local-ai is on", async () => {
    const revoke = await activateForTest(localAi, ["item-draft-assist"]);
    draw(<Suggestions />);
    expect(
      screen.getByRole("button", { name: "Suggest names on device" }),
    ).toBeTruthy();
    revoke();
  });
});
