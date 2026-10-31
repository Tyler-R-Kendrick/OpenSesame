/** The browser interpreter always supplies its local model; no implicit provider. */
import { generateObject as sdkGenerateObject } from "ai";
import { z } from "zod/mini";

const explicitModel = z.object({});

export const generateObject: typeof sdkGenerateObject = (options) => {
  if (!z.safeParse(explicitModel, options.model).success)
    return Promise.reject(
      new Error("An explicit browser language-model object is required."),
    );
  return sdkGenerateObject(options);
};
