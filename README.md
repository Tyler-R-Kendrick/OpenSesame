# Visual evidence under review (never merged)

This branch holds review material for open pull requests, with one folder per
PR under `review/`: before/after comparison sheets, the browser measurements,
and the after-state captures that are candidates for promotion. Nothing on it
is approved, and it is never merged into `main`.

`docs/evidence/README.md` on `main` covers persistence. Once the repository
owner approves a PR's captures, they are promoted from that PR's `current/`
folder with:

```bash
node scripts/dev/promote-evidence.mjs <feature>/<project>/<platform> <dir> \
  --source <implementation-commit-sha> \
  --approved-by <reviewer> --approval-ref <approval-url>
```

Each file stays under the repository's 2 MiB limit.
