/**
 * Figma parity links (`@storybook/addon-designs`). Figma holds the look a
 * component must meet; the story is the component meeting it. Fill
 * `FIGMA_FILE` with the OpenSesame design file's key once it exists
 * (docs/design/tooling.md § Figma) and each story's `node-id` resolves.
 */
const FIGMA_FILE = "";

export function figma(nodeId: string) {
  if (!FIGMA_FILE) return {};
  return {
    design: {
      type: "figma",
      url: `https://www.figma.com/design/${FIGMA_FILE}?node-id=${nodeId}`,
    },
  };
}
