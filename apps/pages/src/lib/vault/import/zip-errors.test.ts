import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZipError, readZipText } from "./zip.js";

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

/** Build an archive from raw parts so corruption is one flag away. */
async function makeArchive(
  entries: EntrySpec[],
  options: {
    eocdCount?: number;
    eocdDirectoryOffset?: number;
    badCentralSignature?: boolean;
    truncateCentral?: number;
  } = {},
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
