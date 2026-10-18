/** Bundle the advertised public types with the same workspace boundary as JS. */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateDtsBundle } from "dts-bundle-generator";
import { z } from "zod";

const targetSchema = z.lazy(() =>
  z.union([
    z.string().transform((target) => ({ target })),
    z
      .object({
        types: targetSchema.optional(),
        import: targetSchema.optional(),
        default: targetSchema.optional(),
      })
      .transform((value) => value.types ?? value.import ?? value.default ?? {}),
  ]),
);
const manifestSchema = z.object({
  name: z.string(),
  exports: z
    .union([
      z.string().transform((target) => ({ ".": { target } })),
      z.record(targetSchema),
    ])
    .optional(),
});

export async function bundleDeclarations(root) {
  const packages = dirname(root);
  const paths = {};
  const inlinedLibraries = ["zod"];
  for (const entry of await readdir(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(packages, entry.name);
    let manifest;
    try {
      manifest = manifestSchema.parse(
        JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
      );
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!manifest.name?.startsWith("@opensesame/") || directory === root)
      continue;
    inlinedLibraries.push(manifest.name);
    for (const [key, { target }] of Object.entries(manifest.exports ?? {})) {
      if (target)
        paths[key === "." ? manifest.name : manifest.name + key.slice(1)] = [
          join(directory, target),
        ];
    }
  }
  const temporary = await mkdtemp(
    join(tmpdir(), "opensesame-cli-declarations-"),
  );
  try {
    const config = join(temporary, "tsconfig.json");
    await writeFile(
      config,
      JSON.stringify({
        extends: join(root, "tsconfig.build.json"),
        compilerOptions: {
          rootDir: dirname(packages),
          baseUrl: dirname(packages),
          typeRoots: [join(root, "node_modules/@types")],
          paths,
        },
      }),
    );
    const [declaration] = generateDtsBundle(
      [
        {
          filePath: join(root, "src/index.ts"),
          libraries: { inlinedLibraries },
          output: { exportReferencedTypes: false },
        },
      ],
      { preferredConfigPath: config },
    );
    if (/["']@opensesame\//u.test(declaration))
      throw new Error(
        "Public declarations retain an unresolved workspace import.",
      );
    await writeFile(join(root, "dist/index.d.ts"), declaration);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
