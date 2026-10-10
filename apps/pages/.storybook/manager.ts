import { addons } from "storybook/manager-api";
import { create } from "storybook/theming";

// The catalog's own chrome in the app's greyscale: ink on canvas, no hue,
// square corners (DESIGN.md).
addons.setConfig({
  theme: create({
    base: "light",
    brandTitle: "OpenSesame",
    brandUrl: "https://tyler-r-kendrick.github.io/OpenSesame/",
    colorPrimary: "#171717",
    colorSecondary: "#4d4d4d",
    appBg: "#fafafa",
    appContentBg: "#ffffff",
    appBorderColor: "#e0e0e0",
    appBorderRadius: 0,
    inputBorderRadius: 0,
    textColor: "#171717",
    textMutedColor: "#666666",
    barTextColor: "#4d4d4d",
    barSelectedColor: "#171717",
    barBg: "#fafafa",
    fontBase: "system-ui, sans-serif",
    fontCode: "ui-monospace, monospace",
  }),
});
