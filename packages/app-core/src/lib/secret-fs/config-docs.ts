/**
 * The vault's other sealed files as readable files (ADR 0182): the settings and
 * extension state the VFS keeps beside the body — a page's preferences, a
 * transport, a drive pairing, a connector's settings. Each is one declarative
 * document with its VFS path and language on the outside and the sealed text
 * on the inside, at the address its Settings page shows it under where it has
 * one (`settings/live/transport.json`) and under `config/` where it does not.
 *
 * The seal is the VFS's own, bound to the tomb and the VFS path, so a document
 * moved to another name is still refused by the file it belongs to. The path in
 * the envelope is what says which VFS file it is; the file name is a label.
 * A value that is not a sealed blob (a header, a marker) is not wrapped and is
 * stored as the text it is.
 */
import type { SealedBlob } from "@opensesame/vault-core";
import { Effect, Schema } from "effect";

export const CONFIG_FORMAT = "opensesame.config";

const Languages = Schema.Literals(["json", "yaml", "toml"]);
export type ConfigLanguage = typeof Languages.Type;

/** `spec/secret-files/config-file.schema.json` is generated from this. */
export const ConfigDoc = Schema.Struct({
  format: Schema.Literal(CONFIG_FORMAT),
  version: Schema.Literal(1),
  path: Schema.String,
  language: Languages,
  sealed: Schema.Struct({ ivB64: Schema.String, ctB64: Schema.String }),
});

const configFile = Schema.fromJsonString(ConfigDoc);
const sealedBlob = Schema.fromJsonString(ConfigDoc.fields.sealed);

/** VFS files whose text is read before the vault opens, and so is never sealed. */
const PLAIN = new Set(["header", "migrated.v1", "seal-bound.v1"]);

/** Where a Settings page shows a VFS file, when it shows it as a file of its own. */
const SETTINGS_ADDRESS = new Map<string, string>([
  ["config/prefs.source.yaml", "settings/prefs.yaml"],
  ["config/live-transport", "settings/live/transport.json"],
  [
    "config/item-types/marketplaces.json",
    "settings/item-types/marketplaces.json",
  ],
]);

export const SETTINGS_DIR = "settings";

export const isPlainPath = (path: string) => PLAIN.has(path);

export function languageOf(path: string): ConfigLanguage {
  if (/\.ya?ml$/.test(path)) return "yaml";
  if (/\.toml$/.test(path)) return "toml";
  return "json";
}

/** The file (inside the vault's directory) a VFS path is kept in. */
export function configFileFor(path: string): string {
  const address = SETTINGS_ADDRESS.get(path) ?? path;
  return address.endsWith(".json") ? address : `${address}.json`;
}

/** The envelope for a sealed value, or `null` when the value is not one. */
export function encodeConfig(path: string, value: string): Uint8Array | null {
  const sealed = Effect.runSync(
    Schema.decodeUnknownEffect(sealedBlob)(value).pipe(
      Effect.match({ onFailure: () => null, onSuccess: (blob) => blob }),
    ),
  );
  if (sealed === null) return null;
  const doc: typeof ConfigDoc.Type = {
    format: CONFIG_FORMAT,
    version: 1,
    path,
    language: languageOf(path),
    sealed,
  };
  return new TextEncoder().encode(`${JSON.stringify(doc, null, 2)}\n`);
}

export type DecodedConfig = Readonly<{ path: string; value: string }>;

/** The VFS path and sealed text a config document holds, or `null` for any other file. */
export function decodeConfig(bytes: Uint8Array): DecodedConfig | null {
  return Effect.runSync(
    Schema.decodeUnknownEffect(configFile)(
      new TextDecoder().decode(bytes),
    ).pipe(
      Effect.match({
        onFailure: () => null,
        onSuccess: (doc) => ({
          path: doc.path,
          value: JSON.stringify(doc.sealed satisfies SealedBlob),
        }),
      }),
    ),
  );
}
