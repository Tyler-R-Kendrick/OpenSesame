import * as cases from "./native-cases.js";
import * as contexts from "./native-context-cas.js";
/** Isolated test entry; no application bootstrap, fake storage, owner issuer or network adapter. */
import { reset } from "./native-fixture.js";
export async function run(name: string, input = "") {
  reset();
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
