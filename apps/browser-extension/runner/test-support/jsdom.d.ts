/** The slice of jsdom the tests use; it ships no types of its own. */
declare module "jsdom" {
  interface JSDOMOptions {
    url?: string;
    runScripts?: "dangerously" | "outside-only";
  }
  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: Window & typeof globalThis;
  }
}
