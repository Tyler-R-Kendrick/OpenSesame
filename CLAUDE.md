<!-- AGENTS.md is the canonical agent context file for this repo; this import keeps CLAUDE.md in sync with it. -->
@AGENTS.md

Evidence persistence follows `AGENTS.md` §5 and `docs/evidence/README.md`:
only approved current-state artifacts in `docs/evidence/<feature>/<project>/<platform>/`.
Keep comparisons, raw recordings and drafts in ignored `work/evidence/` or temp;
replace the affected slot rather than accumulating dates, branches or versions.
Git history preserves prior evidence. Do not rehydrate it into the current tree.

Repository footprint follows `docs/contributing/repository-footprint.md`: source and maintained findings only; task output stays temporary, skills share canonical installs, and startup never generates migrations.
