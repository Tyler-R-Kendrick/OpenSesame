/** @vitest-environment jsdom */
/**
 * The shell's return to the vault (SURFACE-09) is for one case: a capability
 * removed while its section is on screen, so the path the person is on stops
 * matching a rail section *without the person going anywhere*. Following a
 * link from a section to a route that is not a rail section — `/device`, an
 * always-on ceremony — is a navigation, not a removal, and the shell must
 * leave it alone; it used to bounce every such navigation back to `/vault`.
 */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetShellRender, seedVault } from "./app-shell.test-harness.js";

import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { AppShell } from "./AppShell.js";
import { registerLegacyShell } from "./legacy-sections.test-support.js";

const seen: { path: string; go: (to: string) => void } = {
  path: "",
  go: () => undefined,
};

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  seen.path = location.pathname;
  seen.go = navigate;
  return null;
}

function show(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AppShell>
        <Probe />
      </AppShell>
    </MemoryRouter>,
  );
}

let revoke: (() => void) | null = null;
beforeEach(() => {
  seedVault();
  revoke = registerLegacyShell();
});
afterEach(() => {
  revoke?.();
  revoke = null;
  resetShellRender();
});

describe("the shell's denied-route fallback", () => {
  it("lets a navigation from a section to a non-section route stand", () => {
    show("/settings");
    act(() => seen.go("/device"));
    expect(seen.path).toBe("/device");
    act(() => seen.go("/vault"));
    act(() => seen.go("/claim"));
    expect(seen.path).toBe("/claim");
  });

  it("still returns to the vault when the section on screen is removed", () => {
    show("/access");
    expect(seen.path).toBe("/access");
    act(() => {
      revoke?.();
      revoke = null;
    });
    expect(seen.path).toBe("/vault");
  });
});
