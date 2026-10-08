/** @vitest-environment jsdom */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import {
  forgetDeviceConnectors,
  runFeatureConnector,
} from "@opensesame/app-core/lib/device-connectors.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StorageStep } from "./StorageStep.js";

beforeEach(() => {
  forgetDeviceConnectors();
  clearNotices();
});

afterEach(() => {
  cleanup();
  forgetDeviceConnectors();
  clearNotices();
});

async function fill(label: RegExp, value: string) {
  await userEvent.type(screen.getByLabelText(label), value);
}

describe("StorageStep", () => {
  it("offers the bucket's own form, the one Settings draws", () => {
    render(<StorageStep />);
    for (const label of [
      /Endpoint/,
      /Region/,
      /Bucket/,
      /Access key id/,
      /Secret access key/,
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(
      screen.getByLabelText(/Secret access key/).getAttribute("type"),
    ).toBe("password");
  });

  it("saves the bucket on this device with the secret key apart from the public fields", async () => {
    render(<StorageStep />);
    await fill(/Endpoint/, "https://s3.eu-west-1.amazonaws.com");
    await fill(/Region/, "eu-west-1");
    await fill(/Bucket/, "vault-bucket");
    await fill(/Access key id/, "AKIATEST");
    await fill(/Secret access key/, "setup-secret-value");
    await userEvent.click(
      screen.getByRole("button", { name: /Save configuration/ }),
    );

    const provider = catalogProvider("s3");
    if (provider === undefined) throw new Error("s3 is not in the catalog");
    await waitFor(() => expect(runFeatureConnector(provider).ok).toBe(true));
    const run = runFeatureConnector(provider);
    if (!run.ok) throw new Error("nothing saved");
    expect(run.fields.bucket).toBe("vault-bucket");
    expect(run.fields.secret_access_key).toBeUndefined();
    expect(run.secrets.secret_access_key).toBe("setup-secret-value");
    await waitFor(() =>
      expect(listNotices().map((notice) => notice.id)).toContain(
        "setup:storage",
      ),
    );
  });
});
