/**
 * Vite composition plugin: capability id → module chunk + asset ids.
 *
 * Emits `composition-loader-table.json` beside the bundle: every known
 * capability id with its chunk and assets. The forbidden-graph check runs
 * at build time — an id with no owning module fails the build, never the
 * device. Dev mode serves the same table from memory.
 */
import type { Plugin } from "vite";

export type CompositionPluginOptions = {
  /** Capability id → owning source module (relative to the app root). */
  readonly graph: Readonly<Record<string, string>>;
  /** Emitted file name (default composition-loader-table.json). */
  readonly outFile?: string;
};

/** One row of the emitted loader table. */
export type LoaderTableRow = {
  readonly id: string;
  readonly moduleIds: readonly string[];
  readonly assetIds: readonly string[];
};

/** Build the loader-table payload; throws on forbidden ids. */
export function buildLoaderTable(
  graph: Readonly<Record<string, string>>,
  generatedAt: string,
) {
  const entries: LoaderTableRow[] = Object.entries(graph).map(
    ([id, module]) => {
      if (!module) {
        throw new Error(`composition graph has no module for ${id}`);
      }
      return { id, moduleIds: [module], assetIds: [] };
    },
  );
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { generatedAt, entries };
}

/** The Vite plugin. */
export function compositionPlugin(options: CompositionPluginOptions): Plugin {
  const outFile = options.outFile ?? "composition-loader-table.json";
  return {
    name: "opensesame-composition",
    generateBundle(_, bundle) {
      const table = buildLoaderTable(options.graph, new Date().toISOString());
      this.emitFile({
        type: "asset",
        fileName: outFile,
        source: JSON.stringify(table, null, 2),
      });
      void bundle;
    },
  };
}
