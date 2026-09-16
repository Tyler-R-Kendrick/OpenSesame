import { describe, expect, it } from "vitest";

import {
  BLOCKED_REASONS,
  STATUSES,
  TIERS,
  assembleReport,
  exitCodeFor,
  resolveScenario,
  scenarios,
} from "./authority-fabric.mjs";

/** A facts object where nothing is wired, so every probe must fail closed. */
const emptyFacts = {
  crates: {},
  modules: {},
  tests: {},
  testErrors: {},
  packages: {},
  files: {},
  capabilityIds: [],
  ledgerInventory: null,
  ledgerCandidates: [],
  env: {},
};

const cargoScenario = {
  id: "T-01",
  tier: "unit",
  invariant: "INV-GA-01",
  title: "t",
  target: {
    kind: "cargo",
    crate: "opensesame-domain",
    module: "grant_attenuation",
    test: "grant_attenuation::tests::offline_upgrade_fails",
  },
};

const wiredFacts = {
  ...emptyFacts,
  crates: {
    "opensesame-domain": {
      inWorkspace: true,
      member: "crates/domain",
      libPath: "src/lib.rs",
      libExists: true,
    },
  },
  modules: { "opensesame-domain:grant_attenuation": true },
  tests: {
    "opensesame-domain": ["grant_attenuation::tests::offline_upgrade_fails"],
  },
};

describe("the registry itself", () => {
  it("gives every scenario a known tier, a contract, and a target or a reason", () => {
    for (const scenario of scenarios) {
      expect(TIERS).toContain(scenario.tier);
      expect(scenario.invariant).toMatch(/^INV-GA-\d\d$/);
      if (scenario.tier === "unsupported") {
        expect(scenario.unsupported.reason).toBeTruthy();
        expect(scenario.unsupported.wouldRequire).toBeTruthy();
      } else {
        expect(scenario.target).toBeDefined();
      }
    }
  });

  it("uses ids that are unique, so one scenario cannot mask another", () => {
    const ids = scenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves every registered scenario to a known verdict", () => {
    for (const scenario of scenarios) {
      const resolution = resolveScenario(scenario, emptyFacts);
      expect([...STATUSES, "runnable"]).toContain(resolution.status);
    }
  });
});

describe("failing closed", () => {
  it("blocks a crate that is not a workspace member", () => {
    const resolution = resolveScenario(cargoScenario, emptyFacts);
    expect(resolution.status).toBe("blocked");
    expect(resolution.reason).toBe(BLOCKED_REASONS.crateNotInWorkspace);
  });

  it("blocks a crate whose declared lib target does not exist", () => {
    const facts = {
      ...emptyFacts,
      crates: {
        "opensesame-domain": {
          inWorkspace: true,
          member: "crates/domain",
          libPath: "src/lib.rs",
          libExists: false,
        },
      },
    };
    expect(resolveScenario(cargoScenario, facts).reason).toBe(
      BLOCKED_REASONS.crateLibMissing,
    );
  });

  it("blocks a module that is on disk but unreachable from the crate root", () => {
    const facts = {
      ...wiredFacts,
      modules: { "opensesame-domain:grant_attenuation": false },
    };
    expect(resolveScenario(cargoScenario, facts).reason).toBe(
      BLOCKED_REASONS.moduleNotDeclared,
    );
  });

  it("blocks, rather than passes, when the named test does not exist", () => {
    const facts = { ...wiredFacts, tests: { "opensesame-domain": [] } };
    const resolution = resolveScenario(cargoScenario, facts);
    expect(resolution.status).toBe("blocked");
    expect(resolution.reason).toBe(BLOCKED_REASONS.noTest);
  });

  it("carries the compiler's own words when enumeration fails", () => {
    const facts = {
      ...wiredFacts,
      tests: { "opensesame-domain": null },
      testErrors: { "opensesame-domain": "error[E0609]: no field `domain_id`" },
    };
    const resolution = resolveScenario(cargoScenario, facts);
    expect(resolution.reason).toBe(BLOCKED_REASONS.enumerationFailed);
    expect(resolution.detail).toContain("E0609");
  });

  it("only offers a command once the module and the test both exist", () => {
    const resolution = resolveScenario(cargoScenario, wiredFacts);
    expect(resolution.status).toBe("runnable");
    expect(resolution.command).toContain("--exact");
  });

  it("still requires the module to be wired when test checks are deferred", () => {
    const facts = {
      ...wiredFacts,
      deferTests: true,
      modules: { "opensesame-domain:grant_attenuation": false },
    };
    expect(resolveScenario(cargoScenario, facts).reason).toBe(
      BLOCKED_REASONS.moduleNotDeclared,
    );
  });

  it("defers a wired module's test check to the run that will report it", () => {
    const facts = { ...wiredFacts, deferTests: true, tests: {} };
    expect(resolveScenario(cargoScenario, facts).status).toBe("runnable");
  });
});

describe("sweeps that could go quiet", () => {
  const paritySweep = scenarios.find((scenario) => scenario.id === "GA-V-30");
  const ledger = scenarios.find((scenario) => scenario.id === "GA-V-31");

  it("blocks the parity sweep when no authority capability exists to sweep", () => {
    const resolution = resolveScenario(paritySweep, emptyFacts);
    expect(resolution.status).toBe("blocked");
    expect(resolution.reason).toBe(BLOCKED_REASONS.vacuous);
  });

  it("runs the registry's own parity test once an authority capability lands", () => {
    const facts = { ...emptyFacts, capabilityIds: ["authority.grant"] };
    expect(resolveScenario(paritySweep, facts).status).toBe("runnable");
  });

  it("blocks the single-ledger check on a heuristic instead of guessing", () => {
    const facts = {
      ...emptyFacts,
      files: { [ledger.target.canonical]: true },
    };
    const resolution = resolveScenario(ledger, facts);
    expect(resolution.status).toBe("blocked");
    expect(resolution.reason).toBe(BLOCKED_REASONS.harnessMissing);
  });

  it("names an unclassified authority store once the inventory exists", () => {
    const facts = {
      ...emptyFacts,
      files: { [ledger.target.canonical]: true },
      ledgerInventory: { declared: [ledger.target.canonical] },
      ledgerCandidates: [
        ledger.target.canonical,
        "apps/pages/src/lib/rival.ts",
      ],
    };
    const resolution = resolveScenario(ledger, facts);
    expect(resolution.reason).toBe(BLOCKED_REASONS.secondLedger);
    expect(resolution.detail).toContain("rival.ts");
  });

  it("accepts a candidate the inventory explains is not the ledger", () => {
    const facts = {
      ...emptyFacts,
      files: { [ledger.target.canonical]: true },
      ledgerInventory: {
        declared: [ledger.target.canonical],
        notLedgers: [
          { path: "apps/pages/src/lib/local-grant-store.ts", reason: "OIDC" },
        ],
      },
      ledgerCandidates: [
        ledger.target.canonical,
        "apps/pages/src/lib/local-grant-store.ts",
      ],
    };
    expect(resolveScenario(ledger, facts).status).toBe("pass");
  });

  it("refuses to pass the ledger check on an empty candidate scan", () => {
    const facts = {
      ...emptyFacts,
      files: { [ledger.target.canonical]: true },
      ledgerInventory: { declared: [ledger.target.canonical] },
      ledgerCandidates: [],
    };
    const resolution = resolveScenario(ledger, facts);
    expect(resolution.status).toBe("blocked");
    expect(resolution.reason).toBe(BLOCKED_REASONS.vacuous);
  });

  it("blocks the ledger check when the directory could not be scanned", () => {
    const facts = {
      ...emptyFacts,
      files: { [ledger.target.canonical]: true },
      ledgerInventory: { declared: [ledger.target.canonical] },
      ledgerCandidates: null,
    };
    expect(resolveScenario(ledger, facts).reason).toBe(
      BLOCKED_REASONS.harnessMissing,
    );
  });
});

describe("tier separation", () => {
  it("never infers a live result from an unconfigured stack", () => {
    const live = {
      id: "T-live",
      tier: "live",
      invariant: "INV-GA-05",
      title: "t",
      target: {
        kind: "live-stack",
        script: "scripts/live-stack-test.sh",
        requires: ["OPENSESAME_GATEWAY_URL"],
      },
    };
    const resolution = resolveScenario(live, emptyFacts);
    expect(resolution.status).toBe("blocked");
    expect(resolution.reason).toBe(BLOCKED_REASONS.stackNotConfigured);
  });

  it("records an unsupported scenario with what would lift it", () => {
    const unsupported = scenarios.find(
      (scenario) => scenario.tier === "unsupported",
    );
    const resolution = resolveScenario(unsupported, emptyFacts);
    expect(resolution.status).toBe("unsupported");
    expect(resolution.detail).toBeTruthy();
  });

  it("settles INV-GA-05 via the lifecycle unit test, not live-stack", () => {
    const gaV33 = scenarios.find((scenario) => scenario.id === "GA-V-33");
    expect(gaV33.tier).toBe("unit");
    expect(gaV33.target.kind).toBe("cargo");
    expect(gaV33.target.crate).toBe("opensesame-lifecycle");
    expect(gaV33.target.test).toContain("authority_grant_expiry");
  });
});

describe("the report and the exit code", () => {
  const entry = (status, tier = "unit") => ({
    id: `x-${status}-${tier}`,
    tier,
    status,
    invariant: "INV-GA-01",
    title: "t",
  });

  it("counts by status and by tier without asserting a total", () => {
    const report = assembleReport({}, [
      entry("pass"),
      entry("blocked"),
      entry("unsupported", "unsupported"),
    ]);
    expect(report.summary.total).toBe(3);
    expect(report.summary.byStatus.pass).toBe(1);
    expect(report.summary.byTier.unsupported.unsupported).toBe(1);
  });

  it("fails the gate on a blocked scenario, not just on a failing one", () => {
    const report = assembleReport({}, [entry("pass"), entry("blocked")]);
    expect(report.summary.gate).toBe("blocked");
    expect(exitCodeFor(report)).toBe(1);
  });

  it("passes only when every scenario is a pass or a declared unsupported", () => {
    const report = assembleReport({}, [
      entry("pass"),
      entry("unsupported", "unsupported"),
    ]);
    expect(report.summary.gate).toBe("pass");
    expect(exitCodeFor(report)).toBe(0);
  });

  it("does not report a pass when nothing ran at all", () => {
    const report = assembleReport(
      {},
      scenarios.map((s) => ({
        id: s.id,
        tier: s.tier,
        status: s.tier === "unsupported" ? "unsupported" : "blocked",
        invariant: s.invariant,
        title: s.title,
      })),
    );
    expect(report.summary.byStatus.pass).toBe(0);
    expect(exitCodeFor(report)).toBe(1);
  });
});
