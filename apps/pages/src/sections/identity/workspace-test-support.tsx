import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, type NavigateFunction, useNavigate } from "react-router";
import { IdentitySection } from "../IdentitySection.js";
let navigate: NavigateFunction;
function CaptureNavigation() {
  navigate = useNavigate();
  return <IdentitySection />;
}
export function renderIdentity() {
  return render(
    <MemoryRouter initialEntries={["/identity?view=people"]}>
      <CaptureNavigation />
    </MemoryRouter>,
  );
}

export async function openProviderCeremony() {
  await openTab("Providers");
  await userEvent.click(firstButton("Register an IdP"));
}

const views = {
  People: "people",
  Agents: "agents",
  Providers: "providers",
  Devices: "devices",
  Applications: "service-accounts",
  Organizations: "organization",
} as const;
export async function openTab(name: keyof typeof views) {
  await act(async () => {
    await navigate(`/identity?view=${views[name]}`);
  });
  if (name === "Devices")
    await userEvent.click(
      await screen.findByRole("treeitem", { name: "Approve a device" }),
    );
}

/** A device approval answers with a mark; its words are the mark's name. */
export const mark = (name: string | RegExp) =>
  screen.findByRole("img", { name });

export function firstButton(name: string): HTMLElement {
  const matches = screen.getAllByRole("button", { name });
  const found = matches[0];
  if (!found) throw new Error(`no button named ${name}`);
  return found;
}
