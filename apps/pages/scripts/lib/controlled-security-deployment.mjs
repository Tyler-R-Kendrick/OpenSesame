/** Real compiled deployment profiles; the standard shell must refuse local egress. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import {
  createRealItem,
  openDialog,
  ownerAction,
} from "./controlled-security-journey.mjs";
import { PASSWORD } from "./pages-journey.mjs";

export const CONTROLLED_ORIGIN = "http://localhost:41878";
export const CONTROLLED_PORT = 41878;

function artifactSizes(directory) {
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = artifactSizes(target);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      files++;
      bytes += fs.statSync(target).size;
    }
  }
  return { files, bytes };
}

export function deploymentProof(dist, profile, canonicalOrigin) {
  const emitted = JSON.parse(
    fs.readFileSync(path.join(dist, "security-profile.json"), "utf8"),
  );
  assert.equal(emitted.version, 1);
  assert.equal(emitted.profile, profile);
  assert.equal(emitted.canonicalOrigin, canonicalOrigin);
  return {
    profile,
    canonicalOrigin,
    artifactSizes: artifactSizes(dist),
    buildIndexSha256: createHash("sha256")
      .update(fs.readFileSync(path.join(dist, "index.html")))
      .digest("hex"),
  };
}

export async function defaultReceiverRefusal({ page, base, width, receiver }) {
  await createRealItem(page, base, `Private default-profile item ${width}`);
  const dialog = await openDialog(page, base, "Manage observation receiver");
  await dialog
    .getByLabel("Receiver pairing file", { exact: true })
    .setInputFiles(receiver.pairingFile);
  await dialog.getByText(receiver.origin, { exact: true }).waitFor();
  await ownerAction(dialog, "Confirm receiver destination");
  await dialog.getByText("Not tested", { exact: true }).waitFor();
  const requests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin === receiver.origin)
      requests.push(request.method());
  });
  await ownerAction(dialog, "Test observation receiver");
  await expect(
    dialog.getByText("Observation delivery is denied by the current plan.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog.getByText("Not tested", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("Authenticated acknowledgement received", { exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByLabel("Current vault password", { exact: true })
    .fill(PASSWORD);
  await expect(
    dialog.getByRole("button", {
      name: "Enable observation receiver",
      exact: true,
    }),
  ).toBeDisabled();
  assert.deepEqual(requests, []);
  assert.deepEqual(await receiver.receipts(), []);
  return {
    width,
    defaultReceiverDenied: true,
    receiverRequests: 0,
    authenticatedAcknowledgement: false,
    enabledDelivery: false,
  };
}
