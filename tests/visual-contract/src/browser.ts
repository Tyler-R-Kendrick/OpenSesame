import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Prefer explicit ownership, then image browser, then newest installed cache. */
export function resolveChromium(
  explicit: string | undefined,
  pinned: string,
  root: string,
): string | undefined {
  if (explicit) {
    if (!existsSync(explicit))
      throw new Error(
        "PLAYWRIGHT_CHROMIUM does not name an installed browser.",
      );
    return explicit;
  }
  if (existsSync(pinned)) return pinned;
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort(
      (a, b) =>
        Number(b.slice("chromium-".length)) -
        Number(a.slice("chromium-".length)),
    );
  for (const dir of dirs) {
    for (const layout of ["chrome-linux64", "chrome-linux"]) {
      const chrome = join(root, dir, layout, "chrome");
      if (existsSync(chrome)) return chrome;
    }
  }
  return undefined;
}
