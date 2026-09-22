/**
 * Canonical contracts for operator-controlled capability composition.
 *
 * Everything here is data or a type. Nothing imports the DOM, React, a
 * framework, a feature implementation, storage, or a network client. The
 * resolver in `resolve.ts` is pure over these shapes; runtimes (the Pages
 * loader, the service-worker controller, the OpenFeature projection, the
 * configuration editors) consume them and never redefine them.
 *
 * Four identifier universes, kept distinct on purpose (see
 * docs/implementation/capability-composition/ownership.md):
 *
 * - **capability ID** — an installable product function a person selects.
 * - **operation ID** — an existing `@opensesame/capability-registry` action.
 *   Never renamed here; a capability *owns* operations, it is not one.
 * - **module ID** — an executable implementation unit the loader can fetch.
 * - **asset ID** — an emitted build resource (chunk, CSS, worker, file).
 */

export * from "./types-catalog.js";
export * from "./types-documents.js";
export * from "./types-plan.js";
