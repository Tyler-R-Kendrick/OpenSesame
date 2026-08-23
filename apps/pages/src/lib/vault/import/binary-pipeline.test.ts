import { describe, expect, it, vi } from "vitest";

import {
  ADAPTERS,
  ImportError,
  detectFormat,
  parseImport,
  parseImportAsync,
  readImportFile,
} from "./index.js";
import type {
  BinaryImportAdapter,
  DetectInput,
  ParseInput,
  ParseResult,
} from "./types.js";
import { draftLogin, passwordRequired } from "./types.js";

/**
 * The binary path through the import pipeline.
 *
 * Deliberately built on a fake adapter rather than the real KDBX one: what is
 * under test here is the routing and the password loop, and a test that had to
 * decrypt a database to prove the dispatcher works would be testing kdbxweb.
 */

/** A four-byte signature standing in for a real format's magic. */
const MAGIC = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);

function fakeBinaryAdapter(): BinaryImportAdapter & {
  calls: { password: string | undefined }[];
} {
  const calls: { password: string | undefined }[] = [];
  return {
    calls,
    id: "keepass-kdbx",
    label: "Fake binary format",
    shortName: "Fake",
    hint: "Only ever used by this test.",
    accepts: "binary",
    detect: ({ bytes }) =>
      bytes !== null &&
      bytes.length >= MAGIC.length &&
      MAGIC.every((byte, index) => bytes[index] === byte),
    parse: async (input: ParseInput): Promise<ParseResult> => {
      calls.push({ password: input.password });
      if ((input.password ?? "") === "") {
        return passwordRequired("keepass-kdbx", "It is locked.");
      }
      if (input.password !== "open sesame") {
        throw new Error("That password did not open it.");
      }
      const item = draftLogin("Unlocked");
      item.password = "secret";
      return {
        source: "keepass-kdbx",
        items: [item],
        skipped: [],
        warnings: [],
      };
    },
  };
}

function binaryInput(bytes: Uint8Array, fileName = "vault.kdbx"): DetectInput {
  return { fileName, text: "", headers: null, json: null, bytes };
}

function withAdapter<T>(
  adapter: BinaryImportAdapter,
  run: () => T | Promise<T>,
): T | Promise<T> {
  ADAPTERS.unshift(adapter);
  try {
    return run();
  } finally {
    ADAPTERS.shift();
  }
}

describe("readImportFile binary routing", () => {
  function binaryFile(name: string, bytes: Uint8Array): File {
    const file = new File([bytes], name);
    Object.defineProperty(file, "arrayBuffer", {
      value: () =>
        Promise.resolve(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
        ),
    });
    Object.defineProperty(file, "text", {
      value: () => Promise.resolve(new TextDecoder().decode(bytes)),
    });
    return file;
  }

  it("reads a .kdbx as bytes and leaves the text fields empty", async () => {
    const bytes = new Uint8Array([...MAGIC, 0x00, 0x01]);
    const input = await readImportFile(binaryFile("db.kdbx", bytes));
    expect(input.bytes).toEqual(bytes);
    expect(input.text).toBe("");
    expect(input.headers).toBeNull();
    expect(input.json).toBeNull();
  });

  it("re-reads a binary file that was saved under a text-looking name", async () => {
    // A NUL in the first kilobyte is the tell: whatever the extension said,
    // this was never text.
    const bytes = new Uint8Array([...MAGIC, 0x00, 0x02, 0x00]);
    const input = await readImportFile(binaryFile("db.backup", bytes));
    expect(input.bytes).toEqual(bytes);
  });

  it("leaves ordinary text files on the text path with null bytes", async () => {
    const input = await readImportFile(
      new File(["name,password\na,b\n"], "pw.csv"),
    );
    expect(input.bytes).toBeNull();
    expect(input.headers).toEqual(["name", "password"]);
  });

  it("leaves JSON on the text path with its parsed value intact", async () => {
    const input = await readImportFile(
      new File(['{"encrypted":false,"items":[]}'], "export.json"),
    );
    expect(input.bytes).toBeNull();
    expect(input.json).toEqual({ encrypted: false, items: [] });
  });
});

describe("detectFormat with binary input", () => {
  it("offers binary input only to binary adapters", () => {
    const adapter = fakeBinaryAdapter();
    withAdapter(adapter, () => {
      const found = detectFormat(binaryInput(new Uint8Array([...MAGIC, 0x00])));
      expect(found).toBe(adapter);
    });
  });

  it("never lets a text adapter claim a binary file", () => {
    // `genericCsv` accepts almost any CSV and sits last in the chain; without
    // the accept-mode gate it would swallow every database.
    const found = detectFormat(binaryInput(new Uint8Array([...MAGIC, 0x00])));
    expect(found).toBeNull();
  });

  it("never offers text input to a binary adapter", () => {
    const adapter = fakeBinaryAdapter();
    const detect = vi.spyOn(adapter, "detect");
    withAdapter(adapter, () => {
      detectFormat({
        fileName: "pw.csv",
        text: "name,password\na,b\n",
        headers: ["name", "password"],
        json: null,
        bytes: null,
      });
    });
    expect(detect).not.toHaveBeenCalled();
  });

  it("survives a binary detector that throws", () => {
    const adapter = fakeBinaryAdapter();
    adapter.detect = () => {
      throw new Error("bad magic reader");
    };
    withAdapter(adapter, () => {
      expect(detectFormat(binaryInput(new Uint8Array([...MAGIC])))).toBeNull();
    });
  });
});

describe("parseImportAsync and the needsPassword loop", () => {
  it("returns needsPassword instead of throwing on an empty result", async () => {
    const adapter = fakeBinaryAdapter();
    const result = await withAdapter(adapter, () =>
      parseImportAsync(binaryInput(new Uint8Array([...MAGIC, 0x00]))),
    );
    expect(result.needsPassword).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.warnings).toEqual(["It is locked."]);
  });

  it("threads a password through on the re-parse", async () => {
    const adapter = fakeBinaryAdapter();
    const input = binaryInput(new Uint8Array([...MAGIC, 0x00]));
    const result = await withAdapter(adapter, () =>
      parseImportAsync({ ...input, password: "open sesame" }),
    );
    expect(result.needsPassword).toBeUndefined();
    expect(result.items).toHaveLength(1);
    expect(adapter.calls).toEqual([{ password: "open sesame" }]);
  });

  it("propagates a wrong-password failure so the prompt can show it", async () => {
    const adapter = fakeBinaryAdapter();
    const input = binaryInput(new Uint8Array([...MAGIC, 0x00]));
    await expect(
      withAdapter(adapter, () =>
        parseImportAsync({ ...input, password: "wrong" }),
      ),
    ).rejects.toThrow(/did not open it/);
  });

  it("still throws when an unlocked binary parse finds nothing at all", async () => {
    const adapter = fakeBinaryAdapter();
    adapter.parse = async () => ({
      source: "keepass-kdbx",
      items: [],
      skipped: [],
      warnings: [],
    });
    const input = binaryInput(new Uint8Array([...MAGIC, 0x00]));
    await expect(
      withAdapter(adapter, () =>
        parseImportAsync({ ...input, password: "open sesame" }),
      ),
    ).rejects.toThrow(/held no items/);
  });

  it("still reads text formats exactly as the synchronous path does", async () => {
    const input: DetectInput = {
      fileName: ".env",
      text: "KEY=value",
      headers: null,
      json: null,
      bytes: null,
    };
    const asynchronous = await parseImportAsync(input);
    expect(asynchronous).toEqual(parseImport(input));
  });
});

describe("parseImport refusing an asynchronous adapter", () => {
  it("names the format rather than returning a promise as a result", () => {
    const adapter = fakeBinaryAdapter();
    withAdapter(adapter, () => {
      const input = binaryInput(new Uint8Array([...MAGIC, 0x00]));
      expect(() => parseImport(input)).toThrow(ImportError);
      expect(() => parseImport(input)).toThrow(/has to be decrypted/);
    });
  });

  it("leaves no unhandled rejection behind when it refuses", async () => {
    const adapter = fakeBinaryAdapter();
    adapter.parse = () => Promise.reject(new Error("boom"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    withAdapter(adapter, () => {
      expect(() =>
        parseImport(binaryInput(new Uint8Array([...MAGIC, 0x00]))),
      ).toThrow(ImportError);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
