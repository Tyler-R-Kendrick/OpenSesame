import * as cases from "./native-cases.js";
import * as contexts from "./native-context-cas.js";
/** Isolated test entry; no application bootstrap, fake storage, owner issuer or network adapter. */
import { reset } from "./native-fixture.js";
import * as registry from "./native-registry.js";
export async function run(name: string, input = "") {
  reset();
  switch (name) {
    case "deleted-registry":
      return registry.deletedRegistry();
    case "restored-registry":
      return registry.restoredRegistry();
    case "orphan-header":
      return registry.orphanRecord("header");
    case "orphan-body":
      return registry.orphanRecord("body");
    case "catalogue-after-capture-drift":
      return registry.catalogueAfterCaptureDrift();
    case "orphan-retired-record":
      return registry.orphanRecord("retired-credentials.v2");
    case "empty-profile":
      return registry.emptyProfile();
    default:
      return runExistingCase(name, input);
  }
}
function runExistingCase(name: string, input: string) {
  switch (name) {
    case "roundtrip":
      return cases.roundtrip();
    case "no-initialization":
      return cases.noInitialization();
    case "seed-key-loss":
      return cases.seedKeyLoss();
    case "missing-key":
      return cases.missingKey(input);
    case "key-replacement":
      return cases.keyReplacement();
    case "provider-replacement":
      return contexts.providerReplacement();
    case "root-replacement":
      return contexts.rootReplacement();
    case "catalogue-drift":
      return contexts.catalogueDrift();
    case "all-causes-bound":
      return cases.allCausesAndBound();
    case "prepare-cas":
      return contexts.prepareCas(input);
    case "commit-cas":
      return contexts.commitCas();
    case "read-cas":
      return contexts.readCas();
    default:
      throw new Error("Unknown isolated browser proof case.");
  }
}
