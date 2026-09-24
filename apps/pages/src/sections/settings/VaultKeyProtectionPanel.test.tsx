import {
  loadSettings,
  saveSettings,
} from "@opensesame/app-core/lib/settings.js";
import {
  ProtectionNotWiredError,
  protectionLifecycleStubs,
} from "@opensesame/app-core/lib/vault/protection/protection-view.js";
/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { FormatsInteroperabilityPanel } from "./FormatsInteroperabilityPanel.js";
import { VaultKeyProtectionPanel } from "./VaultKeyProtectionPanel.js";

const originalVaultHooksSeams = { ...vaultHooksSeams };

function headerWithPassword() {
  return {
    v: 1 as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    kdf: {
      alg: "PBKDF2-SHA256" as const,
      saltB64: "c2FsdA==",
      iterations: 600_000,
    },
    wrap: { ivB64: "aXY=", ctB64: "Y3Q=" },
  };
}

beforeEach(() => {
  Object.assign(vaultHooksSeams, {
    useVault: () => ({
      header: headerWithPassword(),
      guest: false,
      status: "locked",
    }),
    useVaultStore: () => ({
      protection: {
        enrollCandidate: vi.fn(),
        commitEnrollment: vi.fn(),
        testProtector: vi.fn(),
        setPreferred: vi.fn(),
        removeProtector: vi.fn(),
        rotateCompromisedRoot: vi.fn(),
        listProtectors: vi.fn(() => []),
      },
      getSnapshot: () => ({ header: headerWithPassword() }),
    }),
  });
  const settings = loadSettings();
  saveSettings({
    ...settings,
    capabilityConnectors: {
      ...settings.capabilityConnectors,
      encryption: { providerId: "webcrypto" },
    },
  });
});

afterEach(() => {
  cleanup();
  Object.assign(vaultHooksSeams, originalVaultHooksSeams);
});

describe("VaultKeyProtectionPanel", () => {
  it("lists enrolled Password from the header wrap, never WebCrypto", () => {
    render(<VaultKeyProtectionPanel />);
    expect(
      screen.getByRole("heading", { name: "Vault key protection" }),
    ).toBeTruthy();
    expect(screen.getByText("Password")).toBeTruthy();
    expect(screen.getByLabelText("Verified")).toBeTruthy();
    expect(screen.queryByText(/WebCrypto/i)).toBeNull();
    // The policy is said, not hidden in three glyphs' tooltips.
    const policy = screen.getByRole("list", { name: "Protection policy" });
    expect(policy.textContent).toContain(
      "Any enrolled method can unlock alone",
    );
    expect(policy.textContent).toContain("Removing one does not erase backups");
    expect(policy.textContent).toContain(
      "A cloud method adds an independent authority",
    );
  });

  it("shows encryption preference without enrollment as setup intent (KP-04)", () => {
    const settings = loadSettings();
    saveSettings({
      ...settings,
      capabilityConnectors: {
        ...settings.capabilityConnectors,
        encryption: { providerId: "aws-kms", connectionId: "conn_1" },
      },
    });
    render(<VaultKeyProtectionPanel />);
    expect(screen.getByTestId("setup-intent")).toBeTruthy();
    expect(screen.getByLabelText("Setup intent")).toBeTruthy();
    expect(screen.getByText("AWS KMS")).toBeTruthy();
  });

  it("disables lifecycle actions when the vault is locked", () => {
    render(<VaultKeyProtectionPanel />);
    const add = screen.getByRole("button", {
      name: "Add key protection method",
    });
    if (!(add instanceof HTMLButtonElement)) {
      throw new Error("expected add button");
    }
    expect(add.disabled).toBe(true);
    expect(add.getAttribute("title")).toMatch(/lifecycle is not ready/i);
    const testBtn = screen.getByRole("button", {
      name: /Test Password/i,
    });
    if (!(testBtn instanceof HTMLButtonElement)) {
      throw new Error("expected test button");
    }
    expect(testBtn.disabled).toBe(true);
  });

  it("enables lifecycle actions when unlocked (store-wired)", () => {
    Object.assign(vaultHooksSeams, {
      useVault: () => ({
        header: headerWithPassword(),
        guest: false,
        status: "unlocked",
      }),
    });
    render(<VaultKeyProtectionPanel />);
    const add = screen.getByRole("button", {
      name: "Add key protection method",
    });
    if (!(add instanceof HTMLButtonElement)) {
      throw new Error("expected add button");
    }
    expect(add.disabled).toBe(false);
  });

  it("calls wired action props when lifecycle callbacks are supplied", () => {
    const onAdd = vi.fn();
    const onTest = vi.fn();
    const onPreferred = vi.fn();
    const onRemove = vi.fn();
    const onRotateCompromised = vi.fn();
    render(
      <VaultKeyProtectionPanel
        actions={{
          onAdd,
          onTest,
          onPreferred,
          onRemove,
          onRotateCompromised,
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add key protection method" }),
    );
    expect(onAdd).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Test Password/i }));
    expect(onTest).toHaveBeenCalled();
  });

  it("throws typed not-wired from lifecycle stubs", () => {
    expect(() => protectionLifecycleStubs.add()).toThrow(
      ProtectionNotWiredError,
    );
    try {
      protectionLifecycleStubs.test("x");
    } catch (caught) {
      expect(caught).toBeInstanceOf(ProtectionNotWiredError);
      if (!(caught instanceof ProtectionNotWiredError)) {
        throw caught;
      }
      expect(caught.code).toBe("not_wired");
    }
  });

  it("uses icon-btn actions only — no word-verb button faces", () => {
    const { container } = render(<VaultKeyProtectionPanel />);
    for (const button of container.querySelectorAll("button")) {
      expect(button.className).toMatch(/icon-btn/);
      expect(button.textContent?.trim()).toBe("");
    }
  });
});

describe("FormatsInteroperabilityPanel", () => {
  it("shows native/age/SOPS/GPG with separate R/W/runtime marks", () => {
    render(<FormatsInteroperabilityPanel />);
    expect(screen.getByRole("heading", { name: "Formats" })).toBeTruthy();
    expect(document.getElementById("formats-interoperability")).toBeTruthy();
    expect(screen.getByText("Native")).toBeTruthy();
    expect(screen.getByText("age")).toBeTruthy();
    expect(screen.getByText("SOPS")).toBeTruthy();
    expect(screen.getByText("GPG")).toBeTruthy();
    expect(screen.getByLabelText("Write not in this browser")).toBeTruthy();
    const sops = document.querySelector('[data-format="sops"]');
    expect(sops?.querySelectorAll(".status-mark").length).toBe(3);
  });
});
