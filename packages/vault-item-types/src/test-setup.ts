import { loadEveryPack } from "./packs.test-support.js";

// The registry rules are written against the whole built-in corpus: a clash
// with a built-in's title or extension must still be refused. Packs are on
// demand in the app, so the suite switches every one on first.
await loadEveryPack();
