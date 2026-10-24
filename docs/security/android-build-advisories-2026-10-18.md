# Android build dependency advisory review, 2026-10-18

A local comparison of 420 resolved package/version pairs against all 7,192 public Maven OSV records found the entries below. All occur only in the root Android buildscript/plugin classpath; app compile, runtime and unit-test runtime classpaths have no affected matches. There are 46 distinct advisory IDs and 47 package/advisory entries. These are affected library versions, not 46 demonstrated application vulnerabilities.

The candidate uses a Netty BOM and root buildscript constraints. A scratch resolution with those declarations produces 422 package/version pairs across 409 names and no affected matches against the same complete public database. Actual changed-source resolution and Kotlin/DEX validation are recorded in the [remediation report](github-alert-remediation-2026-10-18.md). No dependency graph was uploaded.

| Advisory | Build dependency | Previous | Selected |
| --- | --- | --- | --- |
| [GHSA-2363-cqg2-863c](https://github.com/advisories/GHSA-2363-cqg2-863c) | `org.jdom:jdom2` | 2.0.6 | 2.0.6.1 |
| [GHSA-3677-xxcr-wjqv](https://github.com/advisories/GHSA-3677-xxcr-wjqv) | `org.bitbucket.b_c:jose4j` | 0.9.5 | 0.9.7 |
| [GHSA-389x-839f-4rhx](https://github.com/advisories/GHSA-389x-839f-4rhx) | `io.netty:netty-common` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-38f8-5428-x5cv](https://github.com/advisories/GHSA-38f8-5428-x5cv) | `io.netty:netty-codec-http` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-3p8m-j85q-pgmj](https://github.com/advisories/GHSA-3p8m-j85q-pgmj) | `io.netty:netty-codec` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-3qp7-7mw8-wx86](https://github.com/advisories/GHSA-3qp7-7mw8-wx86) | `io.netty:netty-handler` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-4265-ccf5-phj5](https://github.com/advisories/GHSA-4265-ccf5-phj5) | `org.apache.commons:commons-compress` | 1.21 | 1.28.0 |
| [GHSA-45q3-82m4-75jr](https://github.com/advisories/GHSA-45q3-82m4-75jr) | `io.netty:netty-handler-proxy` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-4g8c-wm8x-jfhw](https://github.com/advisories/GHSA-4g8c-wm8x-jfhw) | `io.netty:netty-handler` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-4g9r-vxhx-9pgx](https://github.com/advisories/GHSA-4g9r-vxhx-9pgx) | `org.apache.commons:commons-compress` | 1.21 | 1.28.0 |
| [GHSA-4mp9-239f-g9hg](https://github.com/advisories/GHSA-4mp9-239f-g9hg) | `io.netty:netty-codec-http` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-558v-64gr-wgg4](https://github.com/advisories/GHSA-558v-64gr-wgg4) | `io.netty:netty-codec` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-563q-j3cm-6jxm](https://github.com/advisories/GHSA-563q-j3cm-6jxm) | `io.netty:netty-codec-http2` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-574f-3g2m-x479](https://github.com/advisories/GHSA-574f-3g2m-x479) | `org.bouncycastle:bcprov-jdk18on` | 1.79 | 1.86 |
| [GHSA-57rv-r2g8-2cj3](https://github.com/advisories/GHSA-57rv-r2g8-2cj3) | `io.netty:netty-codec-http` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-5x3r-wrvg-rp6q](https://github.com/advisories/GHSA-5x3r-wrvg-rp6q) | `io.netty:netty-codec-http2` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-6cqp-g7gg-8hr5](https://github.com/advisories/GHSA-6cqp-g7gg-8hr5) | `io.netty:netty-codec-http` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-6jqx-86gh-f27w](https://github.com/advisories/GHSA-6jqx-86gh-f27w) | `io.netty:netty-codec-http` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-84h7-rjj3-6jx4](https://github.com/advisories/GHSA-84h7-rjj3-6jx4) | `io.netty:netty-codec-http` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-8c42-7qj2-3j46](https://github.com/advisories/GHSA-8c42-7qj2-3j46) | `io.netty:netty-codec-http` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-93wv-jw9v-4972](https://github.com/advisories/GHSA-93wv-jw9v-4972) | `io.netty:netty-codec-http2` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-9pwp-9qqc-pr26](https://github.com/advisories/GHSA-9pwp-9qqc-pr26) | `org.bouncycastle:bcprov-jdk18on` | 1.79 | 1.86 |
| [GHSA-c2gf-v879-257j](https://github.com/advisories/GHSA-c2gf-v879-257j) | `io.netty:netty-codec-http2` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-c3fc-8qff-9hwx](https://github.com/advisories/GHSA-c3fc-8qff-9hwx) | `org.bouncycastle:bcprov-jdk18on` | 1.79 | 1.86 |
| [GHSA-c4c3-7fpv-j4q5](https://github.com/advisories/GHSA-c4c3-7fpv-j4q5) | `io.netty:netty-handler` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-c653-97m9-rcg9](https://github.com/advisories/GHSA-c653-97m9-rcg9) | `io.netty:netty-handler` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-c69g-56f8-xwqj](https://github.com/advisories/GHSA-c69g-56f8-xwqj) | `io.netty:netty-codec-http2` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-f6hv-jmp6-3vwv](https://github.com/advisories/GHSA-f6hv-jmp6-3vwv) | `io.netty:netty-codec-http` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-f6hv-jmp6-3vwv](https://github.com/advisories/GHSA-f6hv-jmp6-3vwv) | `io.netty:netty-codec-http2` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-fccg-mwvh-qqg4](https://github.com/advisories/GHSA-fccg-mwvh-qqg4) | `io.netty:netty-handler` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-fghv-69vj-qj49](https://github.com/advisories/GHSA-fghv-69vj-qj49) | `io.netty:netty-codec-http` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-gcjf-9mgh-3p7g](https://github.com/advisories/GHSA-gcjf-9mgh-3p7g) | `io.netty:netty-codec-http` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-hvcg-qmg6-jm4c](https://github.com/advisories/GHSA-hvcg-qmg6-jm4c) | `io.netty:netty-codec-http` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-jppx-w49h-x2qq](https://github.com/advisories/GHSA-jppx-w49h-x2qq) | `io.netty:netty-codec-http` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-m4cv-j2px-7723](https://github.com/advisories/GHSA-m4cv-j2px-7723) | `io.netty:netty-codec-http` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-mj4r-2hfc-f8p6](https://github.com/advisories/GHSA-mj4r-2hfc-f8p6) | `io.netty:netty-codec` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-mvh2-crg5-v77c](https://github.com/advisories/GHSA-mvh2-crg5-v77c) | `io.netty:netty-codec-http` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-prj3-ccx8-p6x4](https://github.com/advisories/GHSA-prj3-ccx8-p6x4) | `io.netty:netty-codec-http2` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-pwqr-wmgm-9rr8](https://github.com/advisories/GHSA-pwqr-wmgm-9rr8) | `io.netty:netty-codec-http` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-q4f6-jm68-57ww](https://github.com/advisories/GHSA-q4f6-jm68-57ww) | `io.netty:netty-codec-http` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-qp49-qgx5-5m26](https://github.com/advisories/GHSA-qp49-qgx5-5m26) | `org.bouncycastle:bcprov-jdk18on` | 1.79 | 1.86 |
| [GHSA-v8h7-rr48-vmmv](https://github.com/advisories/GHSA-v8h7-rr48-vmmv) | `io.netty:netty-codec-http` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-w9fj-cfpg-grvv](https://github.com/advisories/GHSA-w9fj-cfpg-grvv) | `io.netty:netty-codec-http2` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-wg6q-6289-32hp](https://github.com/advisories/GHSA-wg6q-6289-32hp) | `org.bouncycastle:bcpkix-jdk18on` | 1.79 | 1.86 |
| [GHSA-x4gw-5cx5-pgmh](https://github.com/advisories/GHSA-x4gw-5cx5-pgmh) | `io.netty:netty-handler` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-xq3w-v528-46rv](https://github.com/advisories/GHSA-xq3w-v528-46rv) | `io.netty:netty-common` | 4.1.110.Final | 4.1.139.Final |
| [GHSA-xxqh-mfjm-7mv9](https://github.com/advisories/GHSA-xxqh-mfjm-7mv9) | `io.netty:netty-codec-http` | 4.1.110.Final | 4.1.139.Final |

Source review: Jetifier's JDOM parser is not enabled in this project; examined compression callers use ZIP rather than the vulnerable Pack200/DUMP formats; Bouncy Castle callers handle generated certificate/key material rather than the specific vulnerable APIs; jose4j is used for code-transparency JWS rather than JWE; and Netty comes through AGP's mutually authenticated TLS instrumentation-result listener, not an application endpoint. The selected task set does not start that listener. The updates remove known affected versions without changing application dependency constraints.
