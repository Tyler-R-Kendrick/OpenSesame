# Share once as a toolbar key, and an account's credentials that all copy

Three changes on an account's page and its row menu, each captured from the base
build and from this branch, walked the same way at phone (390) and desktop
(1280) width.

1. **Share once is a key beside favorite, edit and delete.** It was a headed
   group under the fields with a duration dropdown. Pressing the key now opens
   the ceremony under the fields; how long the share lasts is three choices in a
   row, not a combobox. The toolbar grows from three keys to four.
2. **An API key and a token copy.** The Header row had no copy key. The API key
   row now shows `Not set` when it is empty, the Header copies, and a
   `Header with key` row (`X-Api-Key: key`) and a token's `Bearer header` row
   (`Authorization: Bearer token`) reveal and copy the line a request takes.
   Copying an account that has no password (the list, the command bar, Share
   once) gives that line.
3. **A row's Copy asks which credential.** `Copy secret` is a `Copy` row with a
   submenu of every credential the account holds (the password, the API key and
   its header line, the token and its bearer line, an OAuth client secret and
   refresh token, an authenticator code), or a single named row such as
   `Copy password` when it holds one. On a phone the choices replace the list,
   with a way back, instead of hanging off the screen.

| Measured in the browser | Before | After |
| --- | --- | --- |
| Toolbar, 390 wide | 142x44 @232,230 | 190x44 @184,230 |
| Toolbar, 1280 wide | 142x44 @1110,24 | 190x44 @1062,24 |

| Sheet | Shows |
| --- | --- |
| [`390-detail.png`](390-detail.png), [`1280-detail.png`](1280-detail.png) | The toolbar and every credential row |
| [`390-share-open.png`](390-share-open.png), [`1280-share-open.png`](1280-share-open.png) | The Share key pressed, the ceremony open |
| [`390-copy-menu.png`](390-copy-menu.png), [`1280-copy-menu.png`](1280-copy-menu.png) | The row's menu |
| [`390-copy-choices.png`](390-copy-choices.png), [`1280-copy-choices.png`](1280-copy-choices.png) | Copy, opened; on the base, `Copy secret` copied one value and closed the menu |

The harness walks 1280 with a coarse pointer, so both widths show the phone
arrangement of the menu; a pointer on a wide screen hangs the choices beside the
row, which `VaultTree.credentials.test.tsx` checks.

Journey: [`journey.json`](journey.json).
