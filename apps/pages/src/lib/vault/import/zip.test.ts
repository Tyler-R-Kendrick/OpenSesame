import { describe, expect, it } from "vitest";
import { ZipError, readZipText } from "./zip.js";
import { overlapCast } from "@opensesame/os-domain";

/** CRC-32, needed because a ZIP entry header carries one. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([overlapCast(bytes)])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Build a real single-entry archive so the reader is tested against ZIP, not a mock. */
async function makeZip(
  name: string,
  content: string,
  { store = false }: { store?: boolean } = {},
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);
  const raw = encoder.encode(content);
  const payload = store ? raw : await deflateRaw(raw);
  const method = store ? 0 : 8;
  const crc = crc32(raw);

  const local = new Uint8Array(30 + nameBytes.length + payload.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint16(8, method, true);
  localView.setUint32(14, crc, true);
  localView.setUint32(18, payload.length, true);
  localView.setUint32(22, raw.length, true);
  localView.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(payload, 30 + nameBytes.length);

  const central = new Uint8Array(46 + nameBytes.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint16(10, method, true);
  centralView.setUint32(16, crc, true);
  centralView.setUint32(20, payload.length, true);
  centralView.setUint32(24, raw.length, true);
  centralView.setUint16(28, nameBytes.length, true);
  centralView.setUint32(42, 0, true);
  central.set(nameBytes, 46);

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, 1, true);
  eocdView.setUint16(10, 1, true);
  eocdView.setUint32(12, central.length, true);
  eocdView.setUint32(16, local.length, true);

  const out = new Uint8Array(local.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(eocd, local.length + central.length);
  return out.buffer;
}

describe("readZipText", () => {
  it("inflates a deflated entry", async () => {
    const content = JSON.stringify({ accounts: [{ vaults: [] }] });
    const zip = await makeZip("export.data", content);
    await expect(readZipText(zip, (n) => n === "export.data")).resolves.toBe(
      content,
    );
  });

  it("reads an entry stored without compression", async () => {
    const zip = await makeZip("export.data", "plain", { store: true });
    await expect(readZipText(zip, (n) => n === "export.data")).resolves.toBe(
      "plain",
    );
  });

  it("finds an entry nested in a directory, as 1Password writes it", async () => {
    const zip = await makeZip("export.attributes/export.data", "nested");
    await expect(
      readZipText(zip, (name) => name.endsWith("export.data")),
    ).resolves.toBe("nested");
  });

  it("round-trips content large enough to actually compress", async () => {
    const content = "x".repeat(200_000);
    const zip = await makeZip("export.data", content);
    const out = await readZipText(zip, (n) => n === "export.data");
    expect(out).toHaveLength(200_000);
  });

  it("names what it did find when the entry is absent", async () => {
    const zip = await makeZip("readme.txt", "hello");
    await expect(
      readZipText(zip, (name) => name.endsWith("export.data")),
    ).rejects.toThrow(/readme\.txt/u);
  });

  it("rejects something that is not a ZIP", async () => {
    const notZip = new TextEncoder().encode(
      "this is plain text, not an archive",
    );
    await expect(
      readZipText(overlapCast(notZip.buffer), () => true),
    ).rejects.toThrow(ZipError);
  });
});
