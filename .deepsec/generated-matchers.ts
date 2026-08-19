import { type DeepsecPlugin, compileDeclarativeMatchers } from "deepsec/config";

export const generatedMatchersPlugin: DeepsecPlugin = {
  name: "deepsec-generated-matchers",
  matchers: compileDeclarativeMatchers([]),
};
