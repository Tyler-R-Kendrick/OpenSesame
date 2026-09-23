/**
 * View-model logic for `VaultTree` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import { type BoundaryValue, isString } from "@opensesame/os-domain";
import { readFile, writeFile } from "../../lib/vfs.js";

export const COLLAPSED_PATH = "config/tree-collapsed";

export const encoder = new TextEncoder();

export const decoder = new TextDecoder();

export async function loadCollapsedDefault(tomb: string): Promise<string[]> {
  try {
    const parsed: BoundaryValue = JSON.parse(
      decoder.decode(await readFile(tomb, COLLAPSED_PATH)),
    );
    if (!Array.isArray(parsed)) return [];
    const collapsed: string[] = [];
    for (const path of parsed) if (isString(path)) collapsed.push(path);
    return collapsed;
  } catch {
    return [];
  }
}

export async function saveCollapsedDefault(
  tomb: string,
  paths: string[],
): Promise<void> {
  await writeFile(tomb, COLLAPSED_PATH, encoder.encode(JSON.stringify(paths)));
}

export function rowId(key: string): string {
  return `vtree-row-${key}`;
}
