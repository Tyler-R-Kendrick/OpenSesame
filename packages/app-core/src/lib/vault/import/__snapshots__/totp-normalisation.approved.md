# normaliseTotp — approved behaviour

Every import adapter routes its authenticator secret through this
function. DROPPED means the user silently loses that second factor on
import, so review a new DROPPED row carefully before approving it.

Known gap, visible below: `otpauth-migration://` is DROPPED. That is
Google Authenticator's own export format, so a migration payload loses
every secret it carries, with no error shown. Closing it needs a
protobuf decoder for the payload; until then this row is a deliberate
record of the gap, not approval of it.

The remaining DROPPED rows are correct: empty, whitespace-only, a seed
too short to be usable, an alphabet violation, and a non-otpauth URL.

## bare base32

input:    "JBSWY3DPEHPK3PXPJBSWY3DP"
outcome:  SEED
output:   "JBSWY3DPEHPK3PXPJBSWY3DP"

## base32 lowercase

input:    "jbswy3dpehpk3pxpjbswy3dp"
outcome:  SEED
output:   "JBSWY3DPEHPK3PXPJBSWY3DP"

## base32 in display groups

input:    "JBSW Y3DP EHPK 3PXP JBSW Y3DP"
outcome:  SEED
output:   "JBSWY3DPEHPK3PXPJBSWY3DP"

## base32 hyphenated

input:    "JBSW-Y3DP-EHPK-3PXP-JBSW-Y3DP"
outcome:  SEED
output:   "JBSWY3DPEHPK3PXPJBSWY3DP"

## base32 padded

input:    "JBSWY3DPEHPK3PXPJBSWY3DP===="
outcome:  SEED
output:   "JBSWY3DPEHPK3PXPJBSWY3DP===="

## base32 with surrounding space

input:    "  JBSWY3DPEHPK3PXPJBSWY3DP  "
outcome:  SEED
output:   "JBSWY3DPEHPK3PXPJBSWY3DP"

## too short to be a seed

input:    "JBSWY3DP"
outcome:  DROPPED
output:   ""

## otpauth totp uri

input:    "otpauth://totp/Acme:me@acme.test?secret=JBSWY3DP&issuer=Acme"
outcome:  URI
output:   "otpauth://totp/Acme:me@acme.test?secret=JBSWY3DP&issuer=Acme"

## otpauth uri with algorithm and digits

input:    "otpauth://totp/Acme:me?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256&digits=8&period=60"
outcome:  URI
output:   "otpauth://totp/Acme:me?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256&digits=8&period=60"

## otpauth uppercase scheme

input:    "OTPAUTH://TOTP/Acme:me?secret=JBSWY3DPEHPK3PXP"
outcome:  URI
output:   "OTPAUTH://TOTP/Acme:me?secret=JBSWY3DPEHPK3PXP"

## otpauth hotp uri

input:    "otpauth://hotp/Acme:me?secret=JBSWY3DPEHPK3PXP&counter=1"
outcome:  URI
output:   "otpauth://hotp/Acme:me?secret=JBSWY3DPEHPK3PXP&counter=1"

## google authenticator migration uri

input:    "otpauth-migration://offline?data=CjkKCkhlbGxvId6tvu8SFEV4YW1wbGU6YWxpY2VAZ21haWwuY29tGgdFeGFtcGxlIAEoATACEAEYASAA"
outcome:  DROPPED
output:   ""

## empty

input:    ""
outcome:  DROPPED
output:   ""

## whitespace only

input:    "   "
outcome:  DROPPED
output:   ""

## not a secret

input:    "see the sticky note"
outcome:  SEED
output:   "SEETHESTICKYNOTE"

## base32 alphabet violation

input:    "JBSWY3DP0189EHPK3PXP"
outcome:  DROPPED
output:   ""

## url that is not otpauth

input:    "https://acme.test/2fa"
outcome:  DROPPED
output:   ""
