/**
 * The generated loader table (ownership.md §4.6): only distributed modules,
 * every specifier known at compile time. Kept in its own file so the loader
 * can import it lazily and tests can substitute `loaderSeams.moduleTable`
 * without ever evaluating the virtual module.
 */
export { MODULE_TABLE } from "virtual:opensesame-capability-modules";
