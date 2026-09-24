import { describe, expect, it } from "vitest";
import { runtimeConfig } from "./write-runtime-config.mjs";

describe("runtimeConfig", () => {
  it("keeps only the endpoints a deployment set", () => {
    expect(
      runtimeConfig({
        PAGES_HOST_API: " https://host.example ",
        PAGES_IDENTITY_API: "",
        PAGES_CONNECT_CALLBACK_BASE: "/",
      }),
    ).toEqual({ hostApi: "https://host.example", connectCallbackBase: "/" });
  });

  it("is empty when nothing is set", () => {
    expect(runtimeConfig({})).toEqual({});
  });
});
