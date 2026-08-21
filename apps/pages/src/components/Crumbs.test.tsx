import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";

const vault = {
  items: [
    {
      id: "itm_1",
      name: "Work SSH",
      folderId: "fld_1",
    },
  ],
  folders: [{ id: "fld_1", name: "Work" }],
};

import { vaultHooksSeams } from "../lib/vault/hooks.js";
Object.assign(vaultHooksSeams, {
  useVault: () => vault,
});

import { Crumbs } from "./Crumbs.js";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<Crumbs />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("Crumbs", () => {
  it("navigates ancestor crumbs on a vault item rest path", () => {
    renderAt("/vault/itm_1");
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(nav.textContent).toContain("Vault");
    expect(nav.textContent).toContain("Work");
    expect(nav.textContent).toContain("Work SSH");
    expect(
      screen.getByRole("link", { name: "Vault" }).getAttribute("href"),
    ).toBe("/vault");
    expect(
      screen.getByRole("link", { name: "Work" }).getAttribute("href"),
    ).toBe("/vault?folder=fld_1");
    expect(screen.queryByRole("link", { name: "Work SSH" })).toBeNull();
  });

  it("navigates settings and connection rest paths", () => {
    const { unmount } = renderAt("/settings/connectivity");
    expect(
      screen.getByRole("link", { name: "Settings" }).getAttribute("href"),
    ).toBe("/settings");
    expect(screen.getByText("Connectivity")).toBeTruthy();
    unmount();

    renderAt("/connections/github/conn_1");
    expect(
      screen.getByRole("link", { name: "Connections" }).getAttribute("href"),
    ).toBe("/connections");
    expect(
      screen.getByRole("link", { name: "github" }).getAttribute("href"),
    ).toBe("/connections/github");
  });
});
