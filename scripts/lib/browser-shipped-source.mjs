/** Use the shared test boundary when inspecting browser production sources. */
import { TEST_FILE } from "./app-core-boundary.mjs";

export function isShippedBrowserSource(path) {
  return (
    !TEST_FILE.test(path) &&
    !/\.spec\.[cm]?[jt]sx?$/.test(path) &&
    !/^src\/node\//.test(path)
  );
}
