import { deflateRawSync } from "node:zlib";

function zipEntry(name: string, text: string, offset: number) {
  const encoded = new TextEncoder().encode(name);
  const raw = new TextEncoder().encode(text);
  const payload = deflateRawSync(raw);
  let crc = 0xffffffff;
  for (const byte of raw) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = new Uint8Array(30 + encoded.length + payload.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(8, 8, true);
  lv.setUint32(14, crc, true);
  lv.setUint32(18, payload.length, true);
  lv.setUint32(22, raw.length, true);
  lv.setUint16(26, encoded.length, true);
  local.set(encoded, 30);
  local.set(payload, 30 + encoded.length);
  const central = new Uint8Array(46 + encoded.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint16(10, 8, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, payload.length, true);
  cv.setUint32(24, raw.length, true);
  cv.setUint16(28, encoded.length, true);
  cv.setUint32(42, offset, true);
  central.set(encoded, 46);
  return { local, central };
}

/** Real ZIP fixtures exercise the existing directory/codec reader rather than replacing it. */
export function exportZip(
  entries: readonly (readonly [string, string])[],
): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const { local, central } = zipEntry(name, text, offset);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce(
    (total, entry) => total + entry.length,
    0,
  );
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const all = new Uint8Array(offset + centralSize + end.length);
  let cursor = 0;
  for (const bytes of [...locals, ...centrals, end]) {
    all.set(bytes, cursor);
    cursor += bytes.length;
  }
  return all;
}

export const bitwardenExport = JSON.stringify({
  encrypted: false,
  folders: [{ id: "folder", name: "Imported folder" }],
  items: [
    {
      type: 1,
      name: "Imported Login",
      notes: "import-note-fixture",
      folderId: "folder",
      login: {
        username: "reader",
        password: "import-password-fixture",
        totp: "JBSWY3DPEHPK3PXP",
        uris: [{ uri: "https://example.com" }],
      },
    },
  ],
});
export const onePasswordExport = JSON.stringify({
  accounts: [
    {
      vaults: [
        {
          attrs: { name: "Private" },
          items: [
            {
              item: {
                categoryUuid: "001",
                overview: { title: "OnePassword Login" },
                details: {
                  notesPlain: "1p-notes",
                  loginFields: [
                    { designation: "username", value: "user" },
                    { designation: "password", value: "1p-fixture" },
                  ],
                },
              },
            },
          ],
        },
      ],
    },
  ],
});
export const protonExport = JSON.stringify({
  version: "1.0.0",
  encrypted: false,
  vaults: {
    vault: {
      name: "Personal",
      items: [
        {
          state: 1,
          data: {
            type: "login",
            metadata: { name: "Proton Login", note: "Proton notes" },
            content: {
              itemUsername: "proton-user",
              password: "proton-fixture",
              urls: [],
            },
          },
        },
      ],
    },
  },
});
