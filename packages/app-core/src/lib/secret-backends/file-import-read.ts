import type { BoundaryValue } from "@opensesame/os-domain";
import {
  type DetectInput,
  type SourceId,
  ZipError,
  findSkippedAttachments,
  readImportFile,
  readZipEntryNames,
  readZipText,
} from "../vault/import/index.js";
import { SecretBackendError } from "./types.js";

/** Existing ZIP bounds/codec, with a unique Proton JSON entry instead of 1PUX's export.data. */
export async function readBackendImportFile(
  file: File,
  source: SourceId,
): Promise<DetectInput> {
  const protonZip =
    source === "protonpass-json" && file.name.toLowerCase().endsWith(".zip");
  try {
    // This owns the empty/file-size checks before any archive bytes are read.
    const input = await readImportFile(file);
    if (protonZip) return readProtonArchive(file);
    if (source === "1password-1pux" && /\.(zip|1pux)$/i.test(file.name)) {
      const names = readZipEntryNames(await file.arrayBuffer());
      if (names.filter((name) => name.endsWith("export.data")).length !== 1)
        throw new SecretBackendError(
          "ambiguous",
          "Choose an archive with exactly one 1Password export.data file.",
        );
    }
    return input;
  } catch (error) {
    if (!(error instanceof ZipError) || !protonZip) throw error;
    return readProtonArchive(file, error);
  }
}
async function readProtonArchive(
  file: File,
  originalError?: ZipError,
): Promise<DetectInput> {
  const bytes = await file.arrayBuffer();
  const names = readZipEntryNames(bytes);
  const candidates = names.filter((name) =>
    name.toLowerCase().endsWith(".json"),
  );
  if (candidates.length > 1)
    throw new SecretBackendError(
      "ambiguous",
      "That Proton archive has multiple JSON files. Choose the exported JSON file directly.",
    );
  if (candidates.length === 0) {
    if (names.length === 0 && originalError) throw originalError;
    throw new SecretBackendError(
      "unsupported",
      "Choose an unencrypted Proton Pass JSON or ZIP export. Decrypt encrypted exports locally before importing.",
    );
  }
  const text = await readZipText(bytes, (name) => name === candidates[0]);
  let json: BoundaryValue;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SecretBackendError(
      "response",
      "The Proton archive contains invalid JSON.",
    );
  }
  const input: DetectInput = {
    fileName: file.name,
    text,
    json,
    headers: null,
    bytes: null,
  };
  const attachments = findSkippedAttachments(names);
  if (attachments.count) input.skippedAttachments = attachments;
  return input;
}
