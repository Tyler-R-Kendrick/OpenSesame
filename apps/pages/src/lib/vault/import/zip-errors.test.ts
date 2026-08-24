import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ZipError,
  findSkippedAttachments,
  readZipEntryNames,
  readZipText,
} from "./zip.js";

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

type EntrySpec = {
  name: string;
  content: string;
  method?: number;
  /** Lie about sizes in the central directory, for corruption tests. */
  fakeCompressedSize?: number;
  fakeUncompressedSize?: number;
  /** Corrupt the local header signature. */
  badLocalSignature?: boolean;
};

type ArchiveOptions = {
  eocdCount?: number;
  eocdDirectoryOffset?: number;
  badCentralSignature?: boolean;
  truncateCentral?: number;
};

/** Build an archive from raw parts so corruption is one flag away. */
async function makeArchive(
  entries: EntrySpec[],
  options: ArchiveOptions = {},
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const raw = encoder.encode(entry.content);
    const method = entry.method ?? 8;
    const payload =
      method === 0 ? raw : method === 8 ? await deflateRaw(raw) : raw;
    const crc = crc32(raw);

    const local = new Uint8Array(30 + nameBytes.length + payload.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(
      0,
      entry.badLocalSignature ? 0xdeadbeef : 0x04034b50,
      true,
    );
    localView.setUint16(4, 20, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, payload.length, true);
    localView.setUint32(22, raw.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(payload, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(
      0,
      options.badCentralSignature ? 0xdeadbeef : 0x02014b50,
      true,
    );
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.fakeCompressedSize ?? payload.length, true);
    centralView.setUint32(24, entry.fakeUncompressedSize ?? raw.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  let centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  centralSize -= options.truncateCentral ?? 0;

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, options.eocdCount ?? entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(
    16,
    options.eocdDirectoryOffset ?? locals.reduce((sum, l) => sum + l.length, 0),
    true,
  );

  const total =
    locals.reduce((sum, l) => sum + l.length, 0) + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const local of locals) {
    out.set(local, cursor);
    cursor += local.length;
  }
  for (const central of centrals) {
    out.set(central.subarray(0, Math.max(0, centralSize)), cursor);
    cursor += Math.min(central.length, Math.max(0, centralSize));
  }
  out.set(eocd, cursor);
  return out.buffer;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readZipText corruption handling", () => {
  it("rejects ZIP64 archives with guidance", async () => {
    const zip = await makeArchive([{ name: "export.data", content: "x" }], {
      eocdCount: 0xffff,
    });
    await expect(readZipText(zip, () => true)).rejects.toThrow(/ZIP64/);

    const zip64Offset = await makeArchive(
      [{ name: "export.data", content: "x" }],
      { eocdDirectoryOffset: 0xffffffff },
    );
    await expect(readZipText(zip64Offset, () => true)).rejects.toThrow(/ZIP64/);
  });

  it("rejects archives with an absurd entry count", async () => {
    const zip = await makeArchive([{ name: "export.data", content: "x" }], {
      eocdCount: 5000,
    });
    await expect(readZipText(zip, () => true)).rejects.toThrow(
      /too many entries/,
    );
  });

  it("rejects a truncated central directory", async () => {
    const zip = await makeArchive([{ name: "export.data", content: "x" }], {
      truncateCentral: 40,
    });
    await expect(readZipText(zip, () => true)).rejects.toThrow(/truncated/);
  });

  it("rejects a malformed central directory", async () => {
    const zip = await makeArchive([{ name: "export.data", content: "x" }], {
      badCentralSignature: true,
    });
    await expect(readZipText(zip, () => true)).rejects.toThrow(/malformed/);
  });

  it("rejects an entry whose local header is malformed", async () => {
    const zip = await makeArchive([
      { name: "export.data", content: "x", badLocalSignature: true },
    ]);
    await expect(readZipText(zip, () => true)).rejects.toThrow(
      /entry header is malformed/,
    );
  });

  it("rejects an entry whose payload runs past the archive", async () => {
    const zip = await makeArchive([
      { name: "export.data", content: "x", fakeCompressedSize: 1 << 20 },
    ]);
    await expect(readZipText(zip, () => true)).rejects.toThrow(/truncated/);
  });

  it("rejects an entry that claims to expand beyond the cap", async () => {
    const zip = await makeArchive([
      {
        name: "export.data",
        content: "x",
        fakeUncompressedSize: 65 * 1024 * 1024,
      },
    ]);
    await expect(readZipText(zip, () => true)).rejects.toThrow(/64 MB/);
  });

  it("rejects compression methods it cannot read", async () => {
    const zip = await makeArchive([
      { name: "export.data", content: "x", method: 9 },
    ]);
    await expect(readZipText(zip, () => true)).rejects.toThrow(/method 9/);
  });

  it("rejects an entry whose expanded size disagrees with the directory", async () => {
    const zip = await makeArchive([
      { name: "export.data", content: "abc", fakeUncompressedSize: 999 },
    ]);
    await expect(readZipText(zip, () => true)).rejects.toThrow(/inconsistent/);
  });

  it("says so when the platform cannot inflate", async () => {
    vi.stubGlobal("DecompressionStream", undefined);
    const zip = await makeArchive([{ name: "export.data", content: "x" }]);
    await expect(readZipText(zip, () => true)).rejects.toThrow(
      /cannot decompress/,
    );
  });

  it("lists what an archive holds when the wanted entry is absent", async () => {
    const zip = await makeArchive([
      { name: "a.txt", content: "x" },
      { name: "b.txt", content: "y" },
    ]);
    await expect(
      readZipText(zip, (name) => name === "missing"),
    ).rejects.toThrow(/a\.txt, b\.txt/u);
  });
});

describe("attachments a .1pux import leaves behind", () => {
  it("names the documents a 1Password archive carries beside its data file", async () => {
    // The shape 1Password actually exports: the data file plus a files/
    // directory of attachments, which readZipText ignores entirely.
    const zip = await makeArchive([
      { name: "export.data", content: '{"accounts":[]}' },
      { name: "files/abc123__passport.pdf", content: "%PDF-1.4 scan" },
      { name: "files/def456__w2-2025.pdf", content: "%PDF-1.4 tax" },
    ]);

    const skipped = findSkippedAttachments(readZipEntryNames(zip));
    expect(skipped.count).toBe(2);
    expect(skipped.sample).toContain("abc123__passport.pdf");
    // The data file is not an attachment.
    expect(skipped.sample.join(" ")).not.toContain("export.data");
  });

  it("stays silent for an archive that has no attachments", async () => {
    const zip = await makeArchive([
      { name: "export.data", content: '{"accounts":[]}' },
    ]);
    expect(findSkippedAttachments(readZipEntryNames(zip)).count).toBe(0);
  });

  it("does not count the files/ directory record itself", () => {
    // Directory entries end in a slash and are not documents.
    expect(findSkippedAttachments(["files/"]).count).toBe(0);
    expect(findSkippedAttachments(["export.data", "files/"]).count).toBe(0);
  });

  it("finds attachments when the archive nests everything under a folder", () => {
    // Some exports wrap the whole thing in a top-level directory.
    const skipped = findSkippedAttachments([
      "My Vault/export.data",
      "My Vault/files/xyz__licence.png",
    ]);
    expect(skipped.count).toBe(1);
    expect(skipped.sample).toEqual(["xyz__licence.png"]);
  });

  it("does not mistake a path that merely mentions files for an attachment", () => {
    // `profiles/` ends in "files/" as a substring but is not the files
    // directory; matching on a segment boundary is what keeps these apart.
    expect(findSkippedAttachments(["profiles/data.json"]).count).toBe(0);
    expect(findSkippedAttachments(["myfiles/thing.pdf"]).count).toBe(0);
  });

  it("caps the sample so a large archive does not flood the message", () => {
    const many = Array.from(
      { length: 40 },
      (_, i) => `files/id${i}__doc${i}.pdf`,
    );
    const skipped = findSkippedAttachments(many);
    expect(skipped.count).toBe(40);
    expect(skipped.sample).toHaveLength(3);
  });
});
