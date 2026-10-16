# Shared AI connection bundle cost

The production build of the shared AI connection stack (`e79a9554b`) ships
7,007 KiB JavaScript and 2,118 KiB gzip, compared with its backup parent
(`1fabfaf82`) at 6,978/2,109 KiB. The additional 29/9 KiB includes the shared
native/BYO form, four executable JSON/SSE protocols, actual-vault credential
custody and canonical model-key delegation checks. The independent disk graph
passes with no ownership, reachability or asset mismatch findings.

Set only the default Pages JavaScript ceilings to 7,040/2,132 KiB, leaving
33/14 KiB measured headroom. Attach this explicit feature cost to the shared
connection UI PR, where those implementations become reachable. The existing
total, CSS, largest-asset, hardened-profile and structural limits are unchanged.

The stack was subsequently split without changing any cumulative application
source. Prefix checks verify the smaller dependency boundaries separately;
production evidence remains attributable to the identical application tree.
