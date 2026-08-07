export type DemoCapability = { action: string; resource: string };

export type DemoTask = {
  task_run_id: string;
  state_version: number;
  status: string;
  synthetic: true;
  capability_ceiling: DemoCapability[];
  current_capabilities: DemoCapability[];
  note: string;
};

export function createDemoTask(): DemoTask {
  return {
    task_run_id: "taskrun_demo_offline",
    state_version: 2,
    status: "active",
    synthetic: true,
    capability_ceiling: [
      { action: "repository.read", resource: "repo:acme/catalog" },
      { action: "pull_request.create", resource: "repo:acme/catalog" },
      { action: "send_external", resource: "webhook:notify" },
    ],
    current_capabilities: [
      { action: "repository.read", resource: "repo:acme/catalog" },
      { action: "pull_request.create", resource: "repo:acme/catalog" },
    ],
    note: "Synthetic demo: send_external was removed by Trust Ratchet after a protected read. Live Host API required for real tasks.",
  };
}
