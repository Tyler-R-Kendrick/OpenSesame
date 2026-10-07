import type { Connection, RunnerDeps } from "./loop-types";
import type { OriginalOwner } from "./original-owner";
import type { StepPages } from "./ports";
import type { ServiceDeps } from "./service";
import { type RunnerOwner, ownedIO } from "./worker-authority";

function scopedPages(pages: StepPages, owner: OriginalOwner): StepPages {
  const run = <T>(action: () => Promise<T>) => ownedIO(owner, action);
  return {
    navigate: (url) => run(() => pages.navigate(url)),
    waitFor: (selector, timeout) => run(() => pages.waitFor(selector, timeout)),
    fill: (selector, value) => run(() => pages.fill(selector, value)),
    presence: (selector, value) => run(() => pages.presence(selector, value)),
    submit: (selector) => run(() => pages.submit(selector)),
    readDom: (strip) => run(() => pages.readDom(strip)),
    layout: () => run(() => pages.layout()),
    capture: (masks) => run(() => pages.capture(masks)),
    async fresh() {
      const clean = await ownedIO(
        owner,
        () => pages.fresh(),
        async (created) => {
          if (created) await created.close();
        },
      );
      return clean ? scopedPages(clean, owner) : null;
    },
    // Releasing this original physical resource is cleanup, never fresh authority.
    close: () => pages.close(),
  };
}
function scopedConnection(link: Connection, owner: RunnerOwner): Connection {
  const run = <T>(action: () => Promise<T>) => ownedIO(owner, action);
  return {
    host: {
      listRuns: async () =>
        (await run(() => link.host.listRuns())).filter((row) =>
          owner.owns(row.origin),
        ),
      getRun: (id) => run(() => link.host.getRun(id)),
      claim: (id) => run(() => link.host.claim(id)),
      settle: (id, seq, outcome) =>
        run(() => link.host.settle(id, seq, outcome)),
    },
    backup: {
      push: (id, bytes) => run(() => link.backup.push(id, bytes)),
      confirm: (id, bytes) => run(() => link.backup.confirm(id, bytes)),
    },
  };
}
/** Real classes keep AES/storage lineage; their scoped raw dispatch checks the same witness. */
export function scopedRunnerDeps(
  deps: ServiceDeps,
  owner: RunnerOwner,
): ServiceDeps & Pick<RunnerDeps, "originAllowed"> {
  const run = <T>(action: () => Promise<T>) => ownedIO(owner, action);
  return {
    ...deps,
    settings: deps.settings.withAuthority(owner),
    vault: deps.vault.withAuthority(owner),
    originAllowed: owner.owns,
    grants: {
      has: (origin) =>
        owner.owns(origin)
          ? run(() => deps.grants.has(origin, owner))
          : Promise.resolve(false),
      privateAllowed: () => run(() => deps.grants.privateAllowed(owner)),
      revoke: (origin) => run(() => deps.grants.revoke(origin, owner)),
    },
    async pagesFor(ref) {
      owner.check();
      if (!owner.owns(ref.origin)) return null;
      const pages = await ownedIO(
        owner,
        () => deps.pagesFor(ref, owner),
        async (created) => {
          if (created) await created.close();
        },
      );
      return pages ? scopedPages(pages, owner) : null;
    },
    async connect() {
      const link = await run(() => deps.connect(owner));
      return link ? scopedConnection(link, owner) : null;
    },
    closePage: deps.closePage,
  };
}
