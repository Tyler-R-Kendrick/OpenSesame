import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
/** @vitest-environment jsdom */
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { WrongPasswordError } from "@opensesame/vault-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnlockScreen } from "./UnlockScreen.js";
import {
  ANSWERED,
  resetUnlockHarness,
  setupHolder,
  submitButton,
  v,
} from "./unlock-screen-harness.js";

const wrap = { ivB64: "aXY=", ctB64: "Y3Q=" };

const RECORDS = {
  recovery: {
    kind: "recovery-key",
    protectorId: "recovery_a",
    wrap,
    fingerprintB64: "ZnA=",
    proofStatus: "verified",
  },
  age: {
    kind: "age-recipient",
    protectorId: "age_a",
    recipients: ["age1abc"],
    capsuleAgeB64: "Y3Q=",
    proofStatus: "verified",
  },
  agePasskey: {
    kind: "age-webauthn",
    protectorId: "agepk_a",
    recipient: "AGE-PLUGIN-WEBAUTHN-1X",
    capsuleAgeB64: "Y3Q=",
    proofStatus: "verified",
  },
  aws: {
    kind: "aws-kms",
    protectorId: "aws_a",
    keyArn: "arn:aws:kms:us-west-2:1:key/x",
    region: "us-west-2",
    connectionId: "c",
    connectionConfigVersion: "1",
    wrappedSecretB64: "Y3Q=",
    localCapsule: wrap,
    encryptionContext: {},
    proofStatus: "verified",
  },
  untestedAge: {
    kind: "age-recipient",
    protectorId: "age_u",
    recipients: ["age1zzz"],
    capsuleAgeB64: "Y3Q=",
    proofStatus: "untested",
  },
  passkeyCapsule: {
    kind: "webauthn-prf",
    protectorId: "prf_capsule",
    legacy: false,
    credentialIdB64: "Y3JlZA==",
    rpId: "localhost",
    saltB64: "c2FsdA==",
    wrap,
    userVerification: "required",
    proofStatus: "verified",
  },
} satisfies Record<string, JsonObject>;

function lockedWith(...names: (keyof typeof RECORDS)[]): void {
  v.state = {
    status: "locked",
    header: {
      protection: {
        schemaVersion: 1,
        vaultId: "v",
        rootKeyId: "r",
        rootEpoch: 0,
        revision: 1,
        purpose: "human-vault-root",
        records: names.map((name) => RECORDS[name] ?? {}),
      },
    },
    lockedOutUntil: null,
    failedAttempts: 0,
    durable: true,
    awaitingSecondStep: false,
  };
}

const tabNames = () =>
  screen.getAllByRole("tab").map((tab) => tab.textContent?.trim());

function field(label: string): HTMLInputElement {
  return overlapCast(screen.getByLabelText(label));
}

beforeEach(() => {
  resetUnlockHarness();
  setupHolder.current = ANSWERED;
  v.methods = ["password"];
  v.preferred = "password";
  v.host = { ok: true };
  for (const fn of Object.values(v.store)) fn.mockReset();
  v.store.unlockWithProtector.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  clearNotices();
});

describe("UnlockScreen — tabs for enrolled protectors", () => {
  it("draws exactly the enrolled methods: the header's wraps and the manifest's usable capsules", () => {
    lockedWith("recovery", "age", "agePasskey", "aws", "untestedAge");
    render(<UnlockScreen />);
    expect(tabNames()).toEqual([
      "Password",
      "Age passkey",
      "Age key",
      "Recovery key",
    ]);
  });

  it("draws no protector tab when the manifest enrolled none the screen can use", () => {
    lockedWith("aws", "untestedAge");
    render(<UnlockScreen />);
    expect(screen.queryByRole("tab", { name: "Recovery key" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Age key" })).toBeNull();
    expect(screen.queryByRole("tab", { name: /AWS|Google|KMS/ })).toBeNull();
  });

  it("draws nothing beyond the wraps for a header with no manifest", () => {
    v.state = { ...v.state, status: "locked", header: null };
    render(<UnlockScreen />);
    expect(tabNames()).toEqual(["Password"]);
  });

  it("offers a passkey capsule through the Passkey tab", async () => {
    v.methods = ["password"];
    lockedWith("passkeyCapsule");
    v.store.unlockWithPasskey.mockResolvedValue(undefined);
    render(<UnlockScreen />);
    expect(tabNames()).toEqual(["Password", "Passkey"]);
    fireEvent.click(screen.getByRole("tab", { name: "Passkey" }));
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(v.store.unlockWithPasskey).toHaveBeenCalledTimes(1),
    );
  });

  it("keeps the guest road beside the new tabs", () => {
    lockedWith("recovery");
    render(<UnlockScreen />);
    expect(
      screen.getByRole("button", { name: "Skip to the guest vault" }),
    ).toBeTruthy();
  });

  it("freezes the new tabs for a lockout like the others", () => {
    lockedWith("recovery", "age");
    v.state.lockedOutUntil = Date.now() + 30_000;
    v.state.failedAttempts = 5;
    render(<UnlockScreen />);
    for (const name of ["Age key", "Recovery key"]) {
      const tab = screen.getByRole("tab", { name });
      expect(overlapCast<unknown, HTMLButtonElement>(tab).disabled).toBe(true);
    }
  });
});

describe("UnlockScreen — recovery key", () => {
  it("lands focus in the field on arrival to the tab, and asks for nothing else", () => {
    lockedWith("recovery");
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Recovery key" }));
    const key = field("Recovery key");
    expect(document.activeElement).toBe(key);
    expect(key.type).toBe("password");
    expect(key.getAttribute("autocomplete")).toBe("off");
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(submitButton().getAttribute("aria-label")).toBe(
      "Unlock with recovery key",
    );
    expect(submitButton().disabled).toBe(true);
  });

  it("unlocks with the typed key, then forgets it", async () => {
    lockedWith("recovery");
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Recovery key" }));
    const key = field("Recovery key");
    fireEvent.change(key, { target: { value: "c2VjcmV0" } });
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(v.store.unlockWithProtector).toHaveBeenCalledWith(
        expect.objectContaining({ method: "recovery", secret: "c2VjcmV0" }),
      ),
    );
    await waitFor(() => expect(key.value).toBe(""));
  });

  it("submits on Enter", async () => {
    lockedWith("recovery");
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Recovery key" }));
    fireEvent.change(field("Recovery key"), { target: { value: "c2VjcmV0" } });
    const form = document.querySelector<HTMLFormElement>(".unlock__form");
    if (!form) throw new Error("form");
    fireEvent.submit(form);
    await waitFor(() =>
      expect(v.store.unlockWithProtector).toHaveBeenCalledTimes(1),
    );
  });

  it("says a wrong key is wrong, clears it, and puts the caret back", async () => {
    lockedWith("recovery");
    v.store.unlockWithProtector.mockRejectedValue(
      new WrongPasswordError("That recovery key did not unlock the vault."),
    );
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Recovery key" }));
    const key = field("Recovery key");
    fireEvent.change(key, { target: { value: "bm9wZQ==" } });
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(
        listNotices().some((n) =>
          n.body.includes("That recovery key did not unlock the vault."),
        ),
      ).toBe(true),
    );
    expect(
      screen.queryByText("That recovery key did not unlock the vault."),
    ).toBeNull();
    expect(key.value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(key));
  });

  it("shows and hides the key on request", () => {
    lockedWith("recovery");
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Recovery key" }));
    fireEvent.click(screen.getByRole("button", { name: "Show recovery key" }));
    expect(field("Recovery key").type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide recovery key" }));
    expect(field("Recovery key").type).toBe("password");
  });

  it("hides a revealed password when the person moves to a key tab", () => {
    lockedWith("recovery", "age");
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(field("Password").type).toBe("text");
    fireEvent.click(screen.getByRole("tab", { name: "Recovery key" }));
    expect(field("Recovery key").type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show recovery key" }));
    fireEvent.click(screen.getByRole("tab", { name: "Age key" }));
    expect(field("Age key").type).toBe("password");
    fireEvent.click(screen.getByRole("tab", { name: "Password" }));
    expect(field("Password").type).toBe("password");
  });

  it("drops what was typed when the person moves to another tab", () => {
    lockedWith("recovery", "age");
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Recovery key" }));
    fireEvent.change(field("Recovery key"), { target: { value: "c2VjcmV0" } });
    fireEvent.click(screen.getByRole("tab", { name: "Age key" }));
    expect(field("Age key").value).toBe("");
    fireEvent.click(screen.getByRole("tab", { name: "Recovery key" }));
    expect(field("Recovery key").value).toBe("");
  });

  it("keeps the tabs out of the way of the second step", () => {
    lockedWith("recovery");
    v.state.awaitingSecondStep = true;
    render(<UnlockScreen />);
    expect(screen.queryByRole("tab", { name: "Recovery key" })).toBeNull();
    expect(screen.queryByLabelText("Recovery key")).toBeNull();
    expect(screen.getByLabelText("Authenticator code")).toBeTruthy();
  });
});

describe("UnlockScreen — age key and age passkey", () => {
  it("takes an age identity in its own field", async () => {
    lockedWith("age");
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Age key" }));
    const key = field("Age key");
    expect(key.placeholder).toContain("AGE-SECRET-KEY-1");
    fireEvent.change(key, { target: { value: "AGE-SECRET-KEY-1XYZ" } });
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(v.store.unlockWithProtector).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "age",
          secret: "AGE-SECRET-KEY-1XYZ",
        }),
      ),
    );
  });

  it("draws no field for the passkey tab, lands on the key, and prompts only on click", async () => {
    lockedWith("agePasskey");
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Age passkey" }));
    expect(screen.queryByLabelText("Age key")).toBeNull();
    expect(screen.queryByLabelText("Recovery key")).toBeNull();
    expect(submitButton().getAttribute("aria-label")).toBe(
      "Unlock with passkey",
    );
    expect(submitButton().disabled).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(submitButton()));
    expect(v.store.unlockWithProtector).not.toHaveBeenCalled();
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(v.store.unlockWithProtector).toHaveBeenCalledWith(
        expect.objectContaining({ method: "agePasskey" }),
      ),
    );
  });

  it("holds the passkey tab back when this origin cannot run a ceremony", () => {
    lockedWith("agePasskey");
    v.host = { ok: false, reason: "Passkeys need a DNS hostname." };
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Age passkey" }));
    expect(submitButton().disabled).toBe(true);
    expect(screen.getByText(/Passkeys need a DNS hostname/)).toBeTruthy();
  });
});
