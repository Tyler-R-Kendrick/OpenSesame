import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ResetRecipe,
  recipeMatches,
  recipeSchema,
} from "@opensesame/cua-password-reset";
import { z } from "zod";
import type { PasswordResetCommand } from "./password-reset-parse.js";

const https = z.url().refine((value) => new URL(value).protocol === "https:");
const runtimeSchema = z
  .object({
    module: z.string().min(1).max(512),
    resource: https,
    model: z.string().min(1).max(200),
    modelBaseURL: https,
    modelKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/),
    browser: z.string().min(1).max(512),
    maxSteps: z.number().int().min(1).max(80),
  })
  .strict();
const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    origin: https,
    itemId: z.string().min(1).max(200).optional(),
    transport: z.enum(["cdp", "extension", "proxy"]),
    recipe: z.string().min(1).max(512),
    runId: z.string().min(1).max(128).optional(),
    runtime: runtimeSchema,
  })
  .strict();

export type PasswordResetConfiguration = z.infer<typeof configSchema>;
export type LoadedResetConfiguration = {
  directory: string;
  config: PasswordResetConfiguration;
  recipe: ResetRecipe;
};

type ValidationModule = {
  validatePasswordResetConfiguration?: unknown;
};

const configurationValidatorSchema = z.function({
  input: [z.custom<PasswordResetConfiguration>()],
  output: z.custom<void | Promise<void>>(),
});

export async function validateResetConfiguration(
  config: PasswordResetConfiguration,
  directory: string,
): Promise<void> {
  const path = resolve(directory, config.runtime.module);
  const adapter: ValidationModule = await import(pathToFileURL(path).href);
  const parsed = configurationValidatorSchema.safeParse(
    adapter.validatePasswordResetConfiguration,
  );
  if (!parsed.success)
    throw new Error("Runtime adapter has no configuration validation");
  const validate = parsed.data;
  await validate(config);
}

export async function loadResetConfiguration(
  command: PasswordResetCommand,
): Promise<LoadedResetConfiguration> {
  const path = resolve(command.config);
  if (command.action === "configure") return configure(command, path);
  const config = configSchema.parse(JSON.parse(await readFile(path, "utf8")));
  return loadRecipe(config, dirname(path));
}

async function configure(
  command: PasswordResetCommand,
  path: string,
): Promise<LoadedResetConfiguration> {
  const config = configSchema.parse({
    schemaVersion: 1,
    origin: command.origin,
    itemId: command.itemId,
    recipe: command.recipe,
    transport: command.transport,
    runId: command.runId,
    runtime: {
      module: command.runtimeModule,
      resource: command.runtimeResource,
      model: command.model,
      modelBaseURL: command.modelBaseURL,
      modelKeyEnv: command.modelKeyEnv,
      browser: command.browser,
      maxSteps: command.maxSteps ?? 40,
    },
  });
  const directory = dirname(path);
  const loaded = await loadRecipe(config, directory);
  await validateResetConfiguration(config, directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return loaded;
}

async function loadRecipe(
  config: PasswordResetConfiguration,
  directory: string,
): Promise<LoadedResetConfiguration> {
  const recipe = recipeSchema.parse(
    JSON.parse(await readFile(resolve(directory, config.recipe), "utf8")),
  );
  if (recipe.review !== "approved" || !recipeMatches(recipe, config.origin))
    throw new Error("An approved recipe must match the configured origin");
  return { directory, config, recipe };
}
