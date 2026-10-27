import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type DiscoveryOptions, discoverResetRecipe } from "./discovery.js";
import { type ResetRecipe, recipeSchema } from "./types.js";

export interface RecipeStore {
  get(domain: string): Promise<ResetRecipe | undefined>;
  put(recipe: ResetRecipe): Promise<void>;
}

export class MemoryRecipeStore implements RecipeStore {
  private readonly recipes = new Map<string, ResetRecipe>();

  get(domain: string): Promise<ResetRecipe | undefined> {
    const recipe = this.recipes.get(domain);
    return Promise.resolve(recipe ? structuredClone(recipe) : undefined);
  }

  put(recipe: ResetRecipe): Promise<void> {
    const parsed = recipeSchema.parse(recipe);
    this.recipes.set(parsed.domain, structuredClone(parsed));
    return Promise.resolve();
  }
}

export class FileRecipeStore implements RecipeStore {
  private constructor(private readonly directory: string) {}

  static async open(directory: string): Promise<FileRecipeStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new FileRecipeStore(directory);
  }

  async get(domain: string): Promise<ResetRecipe | undefined> {
    try {
      return recipeSchema.parse(
        JSON.parse(await readFile(this.filename(domain), "utf8")),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    }
  }

  async put(recipe: ResetRecipe): Promise<void> {
    const parsed = recipeSchema.parse(recipe);
    const filename = this.filename(parsed.domain);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(parsed), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, filename);
  }

  private filename(domain: string): string {
    return join(
      this.directory,
      `${createHash("sha256").update(domain).digest("hex")}.json`,
    );
  }
}

export async function firstRunRecipe(
  store: RecipeStore,
  options: DiscoveryOptions,
): Promise<ResetRecipe> {
  const domain = new URL(options.entryUrl).hostname;
  const existing = await store.get(domain);
  if (existing) return existing;
  const discovered = await discoverResetRecipe(options);
  await store.put(discovered);
  return discovered;
}
