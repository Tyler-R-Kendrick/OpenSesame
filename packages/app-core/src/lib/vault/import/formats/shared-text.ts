/**
 * A note handed over by the Web Share Target.
 *
 * The page names the staged file `.opensesame-share.txt`; that exact,
 * internal name is the only way this adapter ever claims text. A normal text
 * file a person picks cannot drift into "shared note" by accident.
 */

import type {
  DetectInput,
  DraftNote,
  ParseResult,
  TextImportAdapter,
} from "../types.js";

const SHARED_NAME = ".opensesame-share.txt";

function basename(fileName: string): string {
  return (fileName.toLowerCase().split(/[/\\]/u).pop() ?? "").trim();
}

function noteName(text: string): string {
  const first = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (first === undefined) return "Shared note";
  return first.length <= 80 ? first : "Shared note";
}

export const sharedText: TextImportAdapter = {
  id: "shared-text",
  label: "Shared text",
  shortName: "Text",
  hint: "Text shared from another app, saved as one note.",
  accepts: "text",
  detect(input: DetectInput): boolean {
    return (
      basename(input.fileName) === SHARED_NAME &&
      input.text.trim() !== "" &&
      input.bytes === null
    );
  },
  parse(input: DetectInput): ParseResult {
    const text = input.text.trim();
    const item: DraftNote = {
      kind: "note",
      name: noteName(text),
      folder: null,
      favorite: false,
      notes: text,
      fields: [],
      createdAt: null,
      updatedAt: null,
      passwordChangedAt: null,
    };
    return {
      source: "shared-text",
      items: [item],
      skipped: [],
      warnings: [],
    };
  },
};
