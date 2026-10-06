// verify:tailnet-sync's attachment walk (ADR 0144): a file sealed in a File
// item on one device is downloaded, byte for byte, on the other — its parts
// carried by the drive beside the snapshot, never readable there.
import { expect } from "@playwright/test";

/** `GET {drive}/v1/vault-drive/slots/{slot}{tail}` with the code's slot key. */
export async function readSlot(drive, code, tail = "/snapshot") {
  const pairing = JSON.parse(
    Buffer.from(code.split(":").at(-1), "base64url").toString(),
  );
  const response = await fetch(
    `${drive}/v1/vault-drive/slots/${pairing.slot}${tail}`,
    { headers: { authorization: `Bearer ${pairing.key}` } },
  );
  return response.json();
}

const NAME = "Scan of the 2025 W-2";
const CONTENT = Buffer.from(
  `Wages, tips, other compensation: 84,210.00\n${"·".repeat(3000)}\n`,
);

/** TS-FILE: seal on `a`, sync both, download on `b`. */
export async function attachmentCrosses({ a, b, drive, code, steps }) {
  const { visit, inStep, toTheList, shot } = steps;
  await visit(a.page, "vault/new/file");
  await a.page.getByLabel("Name", { exact: true }).fill(NAME);
  // The field's own key opens the file picker, as it does for a person.
  const [chooser] = await Promise.all([
    a.page.waitForEvent("filechooser"),
    a.page.getByRole("button", { name: "Choose file", exact: true }).click(),
  ]);
  await chooser.setFiles({
    name: "w2.txt",
    mimeType: "text/plain",
    buffer: CONTENT,
  });
  await a.page.waitForTimeout(1500);
  const save = a.page.getByRole("button", { name: "Save item", exact: true });
  await save.first().click();
  await a.page.waitForTimeout(900);
  await visit(a.page, "settings/vaults");
  await a.page.getByRole("button", { name: "Sync now" }).click();
  await inStep(a.page);
  const { parts } = await readSlot(drive, code, "/parts");
  if (!(parts.length >= 1))
    throw new Error("TS-FILE: no part reached the drive");
  const stored = await readSlot(drive, code);
  if (JSON.stringify(stored).includes("84,210.00"))
    throw new Error("TS-FILE: the drive can read the file");

  await visit(b.page, "settings/vaults");
  await b.page.getByRole("button", { name: "Sync now" }).tap();
  await inStep(b.page);
  await visit(b.page, "vault");
  await toTheList(b.page);
  await b.page.getByText(NAME).first().tap();
  const key = b.page.getByRole("button", { name: "Download file" }).first();
  await expect(key).toBeVisible({ timeout: 20_000 });
  const [download] = await Promise.all([
    b.page.waitForEvent("download"),
    key.tap(),
  ]);
  const chunks = [];
  for await (const chunk of await download.createReadStream())
    chunks.push(chunk);
  if (!Buffer.concat(chunks).equals(CONTENT))
    throw new Error("TS-FILE: the phone downloaded different bytes");
  await shot(b.page, "390-device-b-file");
  console.log(`TS-FILE ok (${parts.length} part(s) on the drive)`);
}
