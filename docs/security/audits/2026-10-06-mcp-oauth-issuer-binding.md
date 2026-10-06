# MCP OAuth issuer binding — 2026-10-06

[GHSA-6qxp-vccf-f47h](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h)
(CVE-2026-104850) affects SDK OAuth clients through 1.30.1. An MCP server
can nominate another authorization server; an unbound OAuth client then sends
its stored client secret or refresh token to that server. The official fixed
1.x release is `@modelcontextprotocol/sdk` 1.31.0.

The npm registry confirms this published release, with source commit
`4b0051f400219f8d8855f9a5433c6df35f15a639`. Its distributed
`dist/esm/client/auth.js` checks the saved client information's issuer before
preparing or sending a token request, and checks again if the provider supplies
client information during request preparation. The interactive OAuth flow
similarly filters issuer-bound tokens and credentials before refresh or client
authentication, and preserves issuer information when saving them.

The repository's MCP host and client packages implement SDK **server** endpoints
using `StdioServerTransport`. Their production sources do not configure HTTP
OAuth providers, bundled client-credential providers, or persisted SDK OAuth
credentials. These paths are explicitly outside the advisory's affected scope;
upgrading the dependency still removes the vulnerable SDK from the lockfile.
The root override and both direct package dependencies pin the fixed release.
No local patch or advisory exemption is needed.

An upgrade alone would not protect an application that kept old credentials
without an issuer, stripped issuer fields when saving credentials, or used a
bundled provider without its expected issuer. The source-to-sink review found
none of these configurations in this repository. This assessment does not claim
that arbitrary future OAuth integrations are safe by version alone.

`packages/mcp-client/src/oauth-issuer-binding.test.ts` exercises the installed
SDK with fictional credentials and a recording fetch seam. It requires a
mismatched issuer to fail before preparation or network access, covers credentials
supplied during preparation, and retains successful refresh at the exact
expected issuer. Both attack regressions failed against 1.30.0 while the
legitimate refresh passed, demonstrating that the tests distinguish the fix.

After the fixed 1.31.0 release was installed, all three OAuth regressions
passed. The full MCP client suite passed 34 tests and the MCP host suite
passed 101 tests; both packages passed typechecking. The shared password-facade
architecture guard also passed. The dependency audit and full repository gates
remain the integration owner's final checks for this updated lockfile.
