/**
 * Item types as files (ADR 0087 §7, ADR 0134):
 *
 *   settings/item-types/marketplaces.json      which repositories to read
 *   settings/item-types/installed/<id>.json    each installed definition
 *   settings/item-types/builtin/<id>.json      the built-ins, read-only
 *
 * `installed/` is the vault body's `itemTypes` map read as a directory: the
 * file is the authored JSON the body keeps, writing one installs it through
 * the same parser and registry rules as any install, and removing one
 * uninstalls it — items of that type keep their values. `marketplaces.json`
 * is a sealed file in the open tomb (`config/item-types/marketplaces.json`);
 * it names public repositories, so it is this device's, not synced.
 */

import { installedDefinitions } from "@opensesame/vault-core";
import {
  BUILTIN_DEFINITION_JSON,
  describeErrors,
  parseDefinition,
} from "@opensesame/vault-item-types";
import {
  DEFAULT_MARKETPLACES_FILE,
  parseMarketplacesFile,
} from "../../lib/item-type-marketplace/marketplaces-file.js";
import { VfsError, readFile, writeFile } from "../../lib/vfs.js";
import {
  type FileCheck,
  type FileOutcome,
  type VirtualFile,
  type VirtualFileProvider,
  baseName,
  directoryOf,
} from "./virtual-files.js";

export const ITEM_TYPES_DIR = "settings/item-types";
export const MARKETPLACES_PATH = `${ITEM_TYPES_DIR}/marketplaces.json`;
export const INSTALLED_DIR = `${ITEM_TYPES_DIR}/installed`;
export const BUILTIN_DIR = `${ITEM_TYPES_DIR}/builtin`;
export const NEW_TYPE_PATH = `${INSTALLED_DIR}/new.json`;
const TOMB_PATH = "config/item-types/marketplaces.json";

export type ItemTypeFilePorts = {
  /** The open tomb the marketplaces file is sealed in, or null. */
  tomb(): string | null;
  install(text: string): Promise<{ ok: true } | { ok: false; message: string }>;
  uninstall(id: string): Promise<boolean>;
};

export function installedPath(id: string): string {
  return `${INSTALLED_DIR}/${id}.json`;
}

function idOf(path: string, directory: string): string | null {
  if (directoryOf(path) !== directory) return null;
  const name = baseName(path);
  return name.endsWith(".json") ? name.slice(0, -".json".length) : null;
}

const BUILTIN_TEXT: Readonly<Record<string, string>> = BUILTIN_DEFINITION_JSON;

const TEMPLATE = `${JSON.stringify(
  {
    apiVersion: "opensesame.dev/v1alpha1",
    kind: "VaultItemType",
    metadata: { id: "", version: "1.0.0", publisher: "https://" },
    spec: {
      title: "",
      plural: "",
      extension: ".",
      summary: "",
      categories: [],
      sections: [{ id: "main", title: "", fields: [] }],
      native: { secret: "", trailer: [] },
      cxf: { credential: "custom-fields" },
      subtitle: [],
      search: [],
    },
  },
  null,
  2,
)}\n`;

function file(
  path: string,
  readOnly: boolean,
  removable: boolean,
): VirtualFile {
  return { path, language: "json", readOnly, removable };
}

function checkDefinition(path: string, text: string): FileCheck {
  const parsed = parseDefinition(text, "community");
  if (!parsed.ok) return { ok: false, message: describeErrors(parsed.errors) };
  const id = parsed.definition.metadata.id;
  const named = idOf(path, INSTALLED_DIR);
  const exists = named !== null && installedDefinitions()[named] !== undefined;
  if (exists && named !== id)
    return {
      ok: false,
      message: `metadata.id is ${id}; this file is ${named}.json. A new id is a new file.`,
    };
  // A new file may not quietly replace a type already installed: that type
  // is changed in its own file, where the person can see what it was.
  if (named !== id && installedDefinitions()[id] !== undefined)
    return {
      ok: false,
      message: `${id} is already installed; change it in ${id}.json.`,
    };
  return { ok: true };
}

async function readMarketplaces(tomb: string | null): Promise<string> {
  if (tomb === null) return DEFAULT_MARKETPLACES_FILE;
  try {
    return new TextDecoder().decode(await readFile(tomb, TOMB_PATH));
  } catch (error) {
    if (error instanceof VfsError) return DEFAULT_MARKETPLACES_FILE;
    throw error;
  }
}

export function itemTypeFiles(ports: ItemTypeFilePorts): VirtualFileProvider {
  const check = (path: string, text: string): FileCheck => {
    if (path === MARKETPLACES_PATH) {
      const parsed = parseMarketplacesFile(text);
      return parsed.ok ? { ok: true } : parsed;
    }
    if (idOf(path, INSTALLED_DIR) !== null) return checkDefinition(path, text);
    return { ok: false, message: "This file is part of the build." };
  };

  const writeDefinition = async (
    path: string,
    text: string,
  ): Promise<FileOutcome> => {
    const checked = checkDefinition(path, text);
    if (!checked.ok) return checked;
    const result = await ports.install(text);
    if (!result.ok) return result;
    const parsed = parseDefinition(text, "community");
    return parsed.ok
      ? { ok: true, path: installedPath(parsed.definition.metadata.id) }
      : { ok: true, path };
  };

  return {
    creates: {
      directory: INSTALLED_DIR,
      draftPath: NEW_TYPE_PATH,
      template: TEMPLATE,
    },
    list: () => [
      file(MARKETPLACES_PATH, false, false),
      ...Object.keys(installedDefinitions())
        .sort()
        .map((id) => file(installedPath(id), false, true)),
      ...Object.keys(BUILTIN_TEXT)
        .sort()
        .map((id) => file(`${BUILTIN_DIR}/${id}.json`, true, false)),
    ],
    async read(path) {
      if (path === MARKETPLACES_PATH) return readMarketplaces(ports.tomb());
      const installed = idOf(path, INSTALLED_DIR);
      if (installed !== null) return installedDefinitions()[installed] ?? "";
      const builtin = idOf(path, BUILTIN_DIR);
      if (builtin !== null) return BUILTIN_TEXT[builtin] ?? "";
      return "";
    },
    check,
    async write(path, text) {
      if (idOf(path, INSTALLED_DIR) !== null)
        return writeDefinition(path, text);
      const checked = check(path, text);
      if (!checked.ok) return checked;
      const tomb = ports.tomb();
      if (tomb === null)
        return { ok: false, message: "Open a vault to keep this file." };
      await writeFile(tomb, TOMB_PATH, new TextEncoder().encode(text));
      return { ok: true, path };
    },
    async remove(path) {
      const id = idOf(path, INSTALLED_DIR);
      if (id === null)
        return { ok: false, message: "This file cannot be removed." };
      if (!(await ports.uninstall(id)))
        return { ok: false, message: `${id} is not installed.` };
      return { ok: true, path };
    },
  };
}
