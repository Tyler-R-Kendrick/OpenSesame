import { roundtrip } from "./native-cases.js";
import { reset } from "./native-fixture.js";
export async function run(name: string) {
  if (name !== "roundtrip")
    throw new Error("Unknown original browser proof case.");
  reset();
  return roundtrip();
}
