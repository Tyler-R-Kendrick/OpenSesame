// Must stay first: installs the host the shared core reads (ADR 0133), the
// same way `src/main.tsx` imports `src/host/boot.ts` before anything else.
import "./host.js";
import type { Decorator, Preview } from "@storybook/react-vite";
import { useEffect } from "react";
import { MemoryRouter } from "react-router";
// The app's stylesheets, in the order main.tsx loads them: a story is the
// app's own DOM on the app's own cascade, nothing re-styled for the catalog.
import "../src/components/command-bar.css";
import "../src/components/connections-tree.css";
import "../src/components/statusline.css";
import "../src/components/wordmark.css";
import "../src/sections/vault.css";
import "../src/sections/vault/path-field.css";
import "../src/styles.css";

/** The app's own theme switch: `data-theme` on the root, read by styles.css. */
const withTheme: Decorator = (Story, { globals }) => {
  const theme = globals.theme === "dark" ? "dark" : "light";
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  return <Story />;
};

/** Components that link (Crumbs) need a router; a memory one asks nothing of the page. */
const withRouter: Decorator = (Story) => (
  <MemoryRouter initialEntries={["/vault"]}>
    <Story />
  </MemoryRouter>
);

const preview: Preview = {
  decorators: [withRouter, withTheme],
  globalTypes: {
    theme: {
      description: "The app's theme (Settings › General › Appearance)",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "light", title: "Day" },
          { value: "dark", title: "Night" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "light" },
  parameters: {
    layout: "padded",
    backgrounds: { disable: true },
    controls: { matchers: { date: /Date$/i } },
    a11y: { test: "todo" },
    options: {
      storySort: {
        order: ["Design system", "Brand", "Controls", "Status", "Shell", "*"],
      },
    },
  },
};

export default preview;
