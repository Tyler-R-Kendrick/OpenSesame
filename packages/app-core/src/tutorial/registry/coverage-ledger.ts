/**
 * The debt ledger of tutorial coverage (ADR 0163 §6).
 *
 * Every control a guide can point at (`target:<id>`) and every key the keymap
 * binds (`key:<command id>`) is taught by a tutorial, or it is named here with
 * the reason it is not. \`coverage.test.ts\` fails on a control with neither, on
 * an entry that a tutorial now covers, and on an entry whose control is gone,
 * so this list only falls: teaching a control means deleting its line.
 *
 * A reason says what is missing. It is never a way to leave a control out:
 * "not worth a tutorial" is not a reason.
 */
export const COVERAGE_EXEMPT = {
  "target:identity.org-signin":
    "sits in the Organizations tab, which a URL query selects, so a guide cannot navigate there; it also needs an owner with a session on a remote Identity API, so it cannot be reached with Next alone",
} as const satisfies Readonly<Record<string, string>>;
