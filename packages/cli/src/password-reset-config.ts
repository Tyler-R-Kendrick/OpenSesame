import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SANDBOX_PROVIDER_IDS } from "@opensesame/agent-sandboxes";
import {
  type ResetRecipe,
  recipeMatches,
  recipeSchema,
} from "@opensesame/cua-password-reset";
import { z } from "zod";
import {
  BUNDLED_LOCAL_MODULE,
  type PasswordResetCommand,
} from "./password-reset-parse.js";

export { BUNDLED_LOCAL_MODULE };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const https = z.url().refine((value) => {
  const url = new URL(value);
  // Config URLs are persisted; embedded credentials must never land in
  // the config file, so userinfo is refused outright.
  if (url.username || url.password) return false;
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK.has(url.hostname))
  );
}, "URL must be https (http is loopback-only) without embedded credentials");
const runtimeSchema = z
  .object({
    module: z.string().min(1).max(512),
    /** Browser sandbox lane for the bundled runtime; defaults to local. */
    provider: z.enum(SANDBOX_PROVIDER_IDS).optional(),
    resource: https.optional(),
    model: z.string().min(1).max(200).optional(),
    modelBaseURL: https.optional(),
    modelKeyEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]{0,127}$/)
      .optional(),
    browser: z.string().min(1).max(512).optional(),
    maxSteps: z.number().int().min(1).max(80),
  })
  .strict()
  .superRefine((runtime, context) => {
    if (runtime.module === BUNDLED_LOCAL_MODULE) return;
    if (runtime.provider !== undefined)
      context.addIssue({
        code: "custom",
        path: ["provider"],
        message:
          "Sandbox providers belong to the bundled runtime; external adapters own their browser",
      });
    for (const key of [
      "resource",
      "model",
      "modelBaseURL",
      "modelKeyEnv",
      "browser",
    ] as const) {
      if (runtime[key] === undefined)
        context.addIssue({
          code: "custom",
          path: [key],
          message: `External runtime modules require ${key}`,
        });
    }
  });
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
  if (config.runtime.module === BUNDLED_LOCAL_MODULE) {
    if (config.transport !== "cdp")
      throw new Error("The bundled local runtime drives CDP transport only");
    return;
  }
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
      provider: command.provider,
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
