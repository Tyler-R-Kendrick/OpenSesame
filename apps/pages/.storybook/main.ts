import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/react-vite";

/** Resolve a package to its directory, so the monorepo's hoisting cannot hide it. */
function pkg(name: string): string {
  return dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`)));
}

const config: StorybookConfig = {
  // Stories live beside the app, not inside `src/`: the capability
  // classification gate walks every file under `src` and would have to own
  // each story, and the shipped bundle must never reach one.
  stories: ["../stories/**/*.mdx", "../stories/**/*.stories.@(ts|tsx)"],
  addons: [
    pkg("@storybook/addon-docs"),
    pkg("@storybook/addon-a11y"),
    pkg("@storybook/addon-designs"),
    pkg("@storybook/addon-mcp"),
  ],
  framework: {
    name: pkg("@storybook/react-vite"),
    options: {
      builder: {
        viteConfigPath: fileURLToPath(
          new URL("./vite.config.ts", import.meta.url),
        ),
      },
    },
  },
  // addon-mcp's `get-ui-building-instructions` reads the components manifest.
  features: { componentsManifest: true },
  staticDirs: ["../public"],
  docs: { defaultName: "Docs" },
};

export default config;
