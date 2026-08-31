/** @vitest-environment jsdom */
/** @vitest-environment-options { "url": "http://pages.internal.example/app/" } */
/**
 * The one http exception that is not loopback: a development deployment served
 * over http may point at itself. It stays an exception — the same host over
 * http is refused the moment the page is not that host.
 */

import { describe, expect, it } from "vitest";
import { readAgUiEndpointUrl } from "./endpoint.js";

describe("readAgUiEndpointUrl on an http page", () => {
  it("accepts an http endpoint on this page's own origin", () => {
    expect(readAgUiEndpointUrl("http://pages.internal.example/agui")?.url).toBe(
      "http://pages.internal.example/agui",
    );
  });

  it("still refuses http on any other origin", () => {
    expect(readAgUiEndpointUrl("http://evil.example/agui")).toBeNull();
    expect(
      readAgUiEndpointUrl("http://pages.internal.example.evil/agui"),
    ).toBeNull();
    expect(
      readAgUiEndpointUrl("http://pages.internal.example:9999/agui"),
    ).toBeNull();
  });
});
