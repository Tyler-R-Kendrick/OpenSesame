import { kvDelete } from "@opensesame/app-core/lib/kv.js";
import { kvSet } from "@opensesame/app-core/lib/kv.js";
import { LAST_VAULT_KEY } from "@opensesame/app-core/lib/last-vault.js";
import { PROJECTS_KEY } from "@opensesame/app-core/lib/projects-state.js";
import { rehydrateProjects } from "@opensesame/app-core/lib/projects.js";
/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useCapabilityChoice } from "./shared.js";

function Probe() {
  const [binding, choose] = useCapabilityChoice("encryption");
  return (
    <button type="button" onClick={() => choose("aws-kms")}>
      {binding.providerId}
    </button>
  );
}

function boot(activeId: string): void {
  act(() => {
    kvSet(PROJECTS_KEY, JSON.stringify({ v: 1, activeId }));
    rehydrateProjects();
  });
}

afterEach(() => {
  kvDelete("settings.v1");
  kvDelete(PROJECTS_KEY);
  kvDelete(LAST_VAULT_KEY);
  rehydrateProjects();
});

describe("useCapabilityChoice", () => {
  it("shows the open vault's binding and leaves the other vault alone", () => {
    render(<Probe />);
    const pick = screen.getByRole("button");
    expect(pick.textContent).toBe("webcrypto");
    fireEvent.click(pick);
    expect(pick.textContent).toBe("aws-kms");

    boot("prj_other");
    expect(pick.textContent).toBe("webcrypto");

    boot("personal");
    expect(pick.textContent).toBe("aws-kms");

    act(() => {
      kvSet(LAST_VAULT_KEY, "guest");
      rehydrateProjects();
    });
    expect(pick.textContent).toBe("webcrypto");

    act(() => {
      kvDelete(LAST_VAULT_KEY);
      boot("personal");
    });
    expect(pick.textContent).toBe("aws-kms");
  });
});
