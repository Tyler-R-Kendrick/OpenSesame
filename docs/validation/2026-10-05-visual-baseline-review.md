# Visual baseline review — 2026-10-05

> Status (2026-10-08): the baselines committed in `.impeccable/screenshots/`
> are main's refresh described in the last paragraph. Of the four reviewed
> hashes below only `vault-unlock-mobile` still matches; `pages-desktop`
> (`8ad77bc3…`), `pages-mobile` (`4b549c73…`) and `vault-list-mobile`
> (`45d92935…`) now hash differently.

The orchestrating reviewer inspected the four failing captures against real, unchanged main `eccd2d9d015b6bdb61c0cc068933fbf62febc888` and the integrated parity build. Both builds reproduce the stale baselines: the front door now includes Help and Account wording, and the phone vault opens its section tree. These reviewed captures intentionally replace only those four baselines. The passing desktop unlock and vault-list baselines remain unchanged.

Pixel budgets, content budgets, timeouts, network checks and semantic assertions are unchanged. The phone assertion follows the actual responsive navigation while still checking unlocked state and available actions.

| Capture | Previous SHA-256 | Reviewed SHA-256 |
| --- | --- | --- |
| pages-desktop | `eee693034250e7cec186e0d48ab2d6765bfe063482f3486b315dbc0a9c885464` | `46ddc3bdb0db22b9e0201960ab7c2b306db7ff38fa22a3889839cb88503d0325` |
| pages-mobile | `90e6241c6bb87d1f5977ffbcfc3ac1eb606e8036bd50e225dafda42ebf04a2cb` | `4bb0fe972b669b4dccc2c2cd454c9a64ddee865141bc233e74bd324b9c77c1e6` |
| vault-unlock-mobile | `e25819bb9f1c523b02d538a7b01516919f4e383825993613ff280ccf73e5c38d` | `6e810bf6d7cfd717f5340bf9e1c3dbbe1bfc43745a808b7e0df04fd1e8096326` |
| vault-list-mobile | `aca6a5f61de1236e1f831f575db0976db9a2c5c15a3a555ae3f3f83adcdf5ea8` | `9ca9a97a882265590f051409f3884110878fea5bfca388a2cba9146f0a735469` |

Fresh main-to-parity comparison of all six captures found zero changed pixels for desktop front door, both unlock views and phone vault tree. Phone front door differed by 29 pixels (0.009%); the desktop vault differed by 2,134 pixels (0.165%), including the new Password workflows action. These comparisons use the contract's unchanged pixelmatch sensitivity of 0.1.

During final integration, main advanced to `e53d2a2ca18628021be020f1c916a9aca793d93e` and independently refreshed these four baselines. The final parity change inherits those main images. Its phone test checks the initial section tree, then opens All items before capturing the list, matching the updated main contract. Visual build isolation and pixel budgets remain unchanged.
