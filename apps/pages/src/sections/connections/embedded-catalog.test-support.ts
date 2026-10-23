import { embeddedCatalogSeams } from "@opensesame/app-core/lib/embedded-catalog.js";
import { vi } from "vitest";

/** Keep embedded catalog reads/writes in the Connections suite's fixture. */
export function installEmbeddedCatalogFixture() {
  const originalEmbeddedCatalogSeams = {
    ...embeddedCatalogSeams,
    bundledProviders: embeddedCatalogSeams.bundledProviders,
  };
  embeddedCatalogSeams.readEmbeddedProviders = () =>
    Promise.resolve(embeddedCatalogSeams.bundledProviders);
  embeddedCatalogSeams.writeEmbeddedProviders = vi
    .fn()
    .mockResolvedValue(undefined);

  return originalEmbeddedCatalogSeams;
}
