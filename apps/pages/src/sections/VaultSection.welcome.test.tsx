/** @vitest-environment jsdom */
import { registerLegacyItemKinds } from "@opensesame/app-core/lib/contributions.test-support.js";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { VaultWelcome } from "./VaultSection.js";
import { makeLogin } from "./vault/section-items.test-support.js";

registerLegacyItemKinds();

const vault: { current: { items: ReturnType<typeof makeLogin>[] } } = {
  current: { items: [] },
};
const original = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, { useVault: () => vault.current });

afterEach(cleanup);
afterAll(() => {
  Object.assign(vaultHooksSeams, original);
});

function welcome(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <VaultWelcome />
    </MemoryRouter>,
  );
  return document.querySelector(".buffer__line")?.textContent;
}

/**
 * The buffer beside the list said "nothing sealed yet" inside Trash and
 * every empty filter — Certificates with a login beside it included.
 */
describe("the buffer states what the list beside it holds", () => {
  it("names the filter the list is showing", () => {
    vault.current = { items: [makeLogin()] };
    expect(welcome("/vault?f=certificate")).toBe("no certificates yet");
    cleanup();
    expect(welcome("/vault?f=login")).toBe("1 item · logins");
  });

  it("says the trash is empty rather than that nothing is sealed", () => {
    vault.current = { items: [makeLogin()] };
    expect(welcome("/vault?f=trash")).toBe("trash is empty");
    expect(screen.queryByText("nothing sealed yet")).toBeNull();
  });
});
