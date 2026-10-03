/** @vitest-environment jsdom */
import type { AwsKmsDeviceConfig } from "@opensesame/app-core/lib/aws-kms-config.js";
import type { GcpKmsDeviceConfig } from "@opensesame/app-core/lib/gcp-kms-config.js";
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { VaultKeyProtectionSheet } from "./VaultKeyProtectionCeremonies.js";
import { externalCeremonyDependencies } from "./VaultKeyProtectionExternalCeremonies.js";

const original = { ...vaultHooksSeams };
const originalDependencies = { ...externalCeremonyDependencies };
const protection = {
  enrollCandidate: vi.fn(),
  commitEnrollment: vi.fn(),
  testProtector: vi.fn(),
};
const flows = {
  enrollAgeRecipientFlow:
    vi.fn<typeof originalDependencies.enrollAgeRecipientFlow>(),
  enrollAwsKmsFlow: vi.fn<typeof originalDependencies.enrollAwsKmsFlow>(),
  enrollGcpKmsFlow: vi.fn<typeof originalDependencies.enrollGcpKmsFlow>(),
  testAgeRecipientFlow:
    vi.fn<typeof originalDependencies.testAgeRecipientFlow>(),
};
const download = vi.fn<typeof originalDependencies.downloadOnce>();

const noAws: AwsKmsDeviceConfig = {
  keyArn: "",
  region: "",
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: null,
  label: null,
  configVersion: "0",
};
const noGcp: GcpKmsDeviceConfig = {
  keyName: "",
  projectId: "",
  serviceAccountJson: "",
  label: null,
  configVersion: "0",
};
let savedAws = noAws;
let savedGcp = noGcp;

beforeEach(() => {
  for (const fn of [
    ...Object.values(flows),
    ...Object.values(protection),
    download,
  ]) {
    fn.mockReset();
  }
  flows.enrollAgeRecipientFlow.mockResolvedValue({
    protectorId: "p1",
    proven: true,
  });
  flows.enrollAwsKmsFlow.mockResolvedValue({ protectorId: "p2", proven: true });
  flows.enrollGcpKmsFlow.mockResolvedValue({ protectorId: "p3", proven: true });
  savedAws = noAws;
  savedGcp = noGcp;
  Object.assign(externalCeremonyDependencies, {
    ...flows,
    downloadOnce: download,
    readAwsKmsConfig: async () => savedAws,
    readGcpKmsConfig: async () => savedGcp,
  });
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ tomb: "personal", status: "unlocked", guest: false }),
    useVaultStore: () => ({ protection }),
  });
});

afterEach(() => {
  cleanup();
  Object.assign(vaultHooksSeams, original);
  Object.assign(externalCeremonyDependencies, originalDependencies);
});

function openAdd(onClose = vi.fn()) {
  render(
    <VaultKeyProtectionSheet request={{ kind: "add" }} onClose={onClose} />,
  );
  return onClose;
}

const lastNotice = () => listNotices().at(-1);

describe("the Add sheet", () => {
  it("offers every key it can enroll as a choice, and states no policy it cannot keep", () => {
    openAdd();
    for (const name of [
      "Recovery key",
      "Passkey / security key",
      "age recipient",
      "age passkey (advanced)",
      "AWS KMS",
      "Google Cloud KMS",
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.queryByText(/unlocks alone/)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("hands over the recovery secret before the record commits", async () => {
    const order: string[] = [];
    protection.enrollCandidate.mockResolvedValue({
      operationId: "op1",
      recoverySecretB64: "c2VjcmV0",
    });
    download.mockImplementation(() => order.push("download"));
    protection.commitEnrollment.mockImplementation(async () => {
      order.push("commit");
    });
    const onClose = openAdd();
    fireEvent.click(screen.getByRole("button", { name: "Recovery key" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(order).toEqual(["download", "commit"]);
    expect(download).toHaveBeenCalledWith(
      "opensesame-recovery-key.txt",
      "c2VjcmV0\n",
    );
  });

  it("enrolls a passkey with a single press and no unchecked-box dead end", async () => {
    protection.enrollCandidate.mockResolvedValue({ operationId: "op2" });
    const onClose = openAdd();
    fireEvent.click(
      screen.getByRole("button", { name: "Passkey / security key" }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(protection.enrollCandidate).toHaveBeenCalledWith("webauthn-prf");
    expect(protection.commitEnrollment).toHaveBeenCalledWith("op2");
  });

  it("enrolls the age passkey from the choice it expands", async () => {
    protection.enrollCandidate.mockResolvedValue({ operationId: "op3" });
    const onClose = openAdd();
    fireEvent.click(
      screen.getByRole("button", { name: "age passkey (advanced)" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add age passkey" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(protection.enrollCandidate).toHaveBeenCalledWith("age-webauthn");
  });
});

describe("age recipient", () => {
  it("passes the pasted recipient and identity to the flow", async () => {
    const onClose = openAdd();
    fireEvent.click(screen.getByRole("button", { name: "age recipient" }));
    fireEvent.change(screen.getByLabelText("Recipient"), {
      target: { value: "age1abc" },
    });
    fireEvent.change(screen.getByLabelText("Identity to prove it"), {
      target: { value: "AGE-SECRET-KEY-1XYZ" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add age recipient" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(flows.enrollAgeRecipientFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        tomb: "personal",
        entry: { recipient: "age1abc", identity: "AGE-SECRET-KEY-1XYZ" },
      }),
    );
  });

  it("keeps the add key off until a recipient is typed", () => {
    openAdd();
    fireEvent.click(screen.getByRole("button", { name: "age recipient" }));
    expect(
      screen
        .getByRole("button", { name: "Add age recipient" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Make a new age key" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("makes a new key pair and saves the identity as an age-keygen file", async () => {
    flows.enrollAgeRecipientFlow.mockImplementation(async (input) => {
      input.deliver({ identity: "AGE-SECRET-KEY-1NEW", recipient: "age1new" });
      return { protectorId: "p1", proven: true };
    });
    const onClose = openAdd();
    fireEvent.click(screen.getByRole("button", { name: "age recipient" }));
    fireEvent.click(screen.getByRole("button", { name: "Make a new age key" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(flows.enrollAgeRecipientFlow).toHaveBeenCalledWith(
      expect.objectContaining({ entry: { recipient: "", identity: "" } }),
    );
    expect(download).toHaveBeenCalledWith(
      "opensesame-vault-age-identity.txt",
      "# public key: age1new\nAGE-SECRET-KEY-1NEW\n",
    );
  });

  it("tells a failure through a notice and keeps the sheet open", async () => {
    flows.enrollAgeRecipientFlow.mockRejectedValue(
      new Error("That is not an age recipient (age1…)."),
    );
    const onClose = openAdd();
    fireEvent.click(screen.getByRole("button", { name: "age recipient" }));
    fireEvent.change(screen.getByLabelText("Recipient"), {
      target: { value: "nope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add age recipient" }));
    await waitFor(() => expect(lastNotice()?.tone).toBe("err"));
    expect(lastNotice()?.body).toContain("not an age recipient");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("cloud keys", () => {
  it("AWS KMS: keeps the add key off until the key and credential are given, then enrolls", async () => {
    const onClose = openAdd();
    fireEvent.click(screen.getByRole("button", { name: "AWS KMS" }));
    const add = () => screen.getByRole("button", { name: "Add AWS KMS" });
    expect(add().hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText(/Key ARN/), {
      target: { value: "arn:aws:kms:us-east-1:123456789012:key/x" },
    });
    fireEvent.change(screen.getByLabelText(/Access key ID/), {
      target: { value: "AKIAEXAMPLEEXAMPLE" },
    });
    fireEvent.change(screen.getByLabelText(/Secret access key/), {
      target: { value: "secret" },
    });
    expect(add().hasAttribute("disabled")).toBe(false);
    fireEvent.click(add());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(flows.enrollAwsKmsFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        tomb: "personal",
        entry: expect.objectContaining({
          keyArn: "arn:aws:kms:us-east-1:123456789012:key/x",
          secretAccessKey: "secret",
        }),
      }),
    );
  });

  it("AWS KMS: a connection already saved needs no secret typed again", async () => {
    savedAws = {
      ...noAws,
      keyArn: "arn:aws:kms:us-east-1:123456789012:key/x",
      region: "us-east-1",
      accessKeyId: "AKIAEXAMPLEEXAMPLE",
      secretAccessKey: "sealed",
    };
    openAdd();
    fireEvent.click(screen.getByRole("button", { name: "AWS KMS" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Add AWS KMS" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    const secret: HTMLInputElement = screen.getByLabelText(/Secret access key/);
    expect(secret.value).toBe("");
  });

  it("Google Cloud KMS: enrolls with the key name and service account", async () => {
    const onClose = openAdd();
    fireEvent.click(screen.getByRole("button", { name: "Google Cloud KMS" }));
    fireEvent.change(screen.getByLabelText(/Crypto key/), {
      target: { value: "projects/p/locations/global/keyRings/r/cryptoKeys/k" },
    });
    fireEvent.change(screen.getByLabelText(/Service account JSON/), {
      target: { value: '{"client_email":"a@b","private_key":"k"}' },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add Google Cloud KMS" }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(flows.enrollGcpKmsFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          keyName: "projects/p/locations/global/keyRings/r/cryptoKeys/k",
        }),
      }),
    );
  });

  it("names the provider's refusal through a notice", async () => {
    flows.enrollGcpKmsFlow.mockRejectedValue(
      new Error("Google refused the service-account credential (400)."),
    );
    openAdd();
    fireEvent.click(screen.getByRole("button", { name: "Google Cloud KMS" }));
    fireEvent.change(screen.getByLabelText(/Crypto key/), {
      target: { value: "projects/p/locations/global/keyRings/r/cryptoKeys/k" },
    });
    fireEvent.change(screen.getByLabelText(/Service account JSON/), {
      target: { value: "{}" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add Google Cloud KMS" }),
    );
    await waitFor(() => expect(lastNotice()?.tone).toBe("err"));
    expect(lastNotice()?.body).toContain("refused");
  });
});

describe("Test age recipient", () => {
  it("proves with the identity typed for this test", async () => {
    const onClose = vi.fn();
    render(
      <VaultKeyProtectionSheet
        request={{ kind: "test-age", protectorId: "age_1" }}
        onClose={onClose}
      />,
    );
    const test = screen.getByRole("button", { name: "Test" });
    expect(test.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Identity"), {
      target: { value: "AGE-SECRET-KEY-1XYZ" },
    });
    fireEvent.click(test);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(flows.testAgeRecipientFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        protectorId: "age_1",
        identity: "AGE-SECRET-KEY-1XYZ",
        tomb: "personal",
      }),
    );
  });
});
