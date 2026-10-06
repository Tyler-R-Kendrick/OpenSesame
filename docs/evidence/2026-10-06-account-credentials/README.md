# Account credential workflows

Two real builds follow the same guest journey at 1280 × 900 and 390 × 900:
main `4b422255e` and the parity implementation integrated with main `6fc96a6aa`.
The Account UI is unchanged between those two upstream revisions. Each journey
creates an account through its editor, opens Options, selects My own, enters a
harmless fixture password, and turns Include pepper off. Protected passwords
retain their separate private-input boundary.

The existing account controls remain above the added reference and comparison
section. The after image brings that section into view. Stored passwords are
concealed, plaintext-download confirmation is unchecked, and candidate inputs
are empty.

| Measurement | Main | Parity implementation |
| --- | --- | --- |
| Credential reference section | 0 | 1 |
| Reference and comparison fieldsets | 0 | 2 |
| Desktop action buttons | Absent | 32 × 32 px |
| Phone action buttons | Absent | 44 × 44 px |

![Desktop account before and after](desktop-account.png)

![Phone account before and after](phone-account.png)

References identify the account method, and comparison updates only the chosen
password method. Pepper-slotted and legacy passwords use the Account's existing
controls; metadata operations never return an algorithmic generator root.
Failure regression tests verify safe tray notices and refusal to recreate an
account withdrawn while its private password editor remains open.

The before artifact has index SHA-256
`6861a1925de164efdae1ec542ef11c71f45c77d2d9770f77fdbfe54a1b7248a3`.
The after artifact has index SHA-256
`143f06f00977225ef82623d7e889cd57a840d26a65e49e63475c4c5f3102e27a`.
The journey records the actual browser measurements and captured artifact
identities. The pull request identifies the implementation revision separately.
