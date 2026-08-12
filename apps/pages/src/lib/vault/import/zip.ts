/**
 * Just enough ZIP to read one named entry out of a 1Password .1pux archive.
 *
 * The platform already ships the hard part: `DecompressionStream("deflate-raw")`
 * is the exact codec ZIP method 8 uses. So this reads the central directory,
 * finds the entry, and hands its bytes to the browser — no dependency, and
 * nothing that could reach the network.
 */

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The EOCD is last, but a trailing comment of up to 64 KiB may follow it. */
const MAX_EOCD_SCAN = 0xffff + 22;

type CentralEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

function findEocd(view: DataView): number {
  const start = Math.max(0, view.byteLength - MAX_EOCD_SCAN);
  for (let i = view.byteLength - 22; i >= start; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw new ZipError("That file is not a ZIP archive.");
}

function readCentralDirectory(
  view: DataView,
  bytes: Uint8Array,
): CentralEntry[] {
  const eocd = findEocd(view);
  const count = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);

  if (directoryOffset === 0xffffffff || count === 0xffff) {
    throw new ZipError(
      "That archive uses ZIP64, which this importer cannot read. Export a smaller archive, or unzip it and import export.data directly.",
    );
  }

  const entries: CentralEntry[] = [];
  let cursor = directoryOffset;
  const decoder = new TextDecoder();

  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > view.byteLength) {
      throw new ZipError("That archive's directory is truncated.");
    }
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError("That archive's directory is malformed.");
    }
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    entries.push({
      method: view.getUint16(cursor + 10, true),
      compressedSize: view.getUint32(cursor + 20, true),
      uncompressedSize: view.getUint32(cursor + 24, true),
      localHeaderOffset: view.getUint32(cursor + 42, true),
      name: decoder.decode(
        bytes.subarray(cursor + 46, cursor + 46 + nameLength),
      ),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function inflateRaw(input: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new ZipError(
      "This browser cannot decompress ZIP archives. Unzip the export yourself and import export.data.",
    );
  }
  const stream = new Blob([input as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read one entry by name, or by a predicate when the archive nests it under a
 * directory. Returns the decoded text.
 */
export async function readZipText(
  buffer: ArrayBuffer,
  matches: (name: string) => boolean,
): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const entries = readCentralDirectory(view, bytes);

  const entry = entries.find((candidate) => matches(candidate.name));
  if (!entry) {
    throw new ZipError(
      `That archive has no export data in it. It contains: ${
        entries
          .slice(0, 8)
          .map((e) => e.name)
          .join(", ") || "nothing"
      }.`,
    );
  }

  // The central directory records name and extra lengths that may differ from
  // the local header's, so the payload offset has to come from the local one.
  const local = entry.localHeaderOffset;
  if (
    local + 30 > view.byteLength ||
    view.getUint32(local, true) !== LOCAL_SIGNATURE
  ) {
    throw new ZipError("That archive's entry header is malformed.");
  }
  const nameLength = view.getUint16(local + 26, true);
  const extraLength = view.getUint16(local + 28, true);
  const start = local + 30 + nameLength + extraLength;
  const payload = bytes.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return new TextDecoder().decode(payload);
  if (entry.method !== 8) {
    throw new ZipError(
      `That archive uses compression method ${entry.method}, which this importer cannot read.`,
    );
  }
  return new TextDecoder().decode(await inflateRaw(payload));
}
