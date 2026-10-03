let meta = #{
    name: "task-swarm",
    description: "Fan a task's independent slices across one copy-on-write worktree",
    when_to_use: "Starting a goal: parallelize disjoint slices, then verify the worktree",
    phases: [
        #{ title: "Implement", detail: "one agent per slice" },
        #{ title: "Verify", detail: "read the worktree diff" },
    ],
};

let slice_schema = #{
    "type": "object",
    "required": ["label", "ok"],
    "properties": #{
        "label": #{ "type": "string" },
        "ok": #{ "type": "boolean" },
        "note": #{ "type": "string" },
    },
};

let verdict_schema = #{
    "type": "object",
    "required": ["ok", "gaps"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "gaps": #{ "type": "array", "items": #{ "type": "string" } },
    },
};

let worktree = if args == () { () } else { args.worktree };
let slices = if args == () { () } else { args.slices };
if worktree == () || slices == () {
    pause("verification", "Pass args.worktree and args.slices, an array of {label, prompt}.");
}

phase("Implement");
let jobs = [];
let i = 0;
for slice in slices {
    let prompt = "Work only inside " + worktree + ". Never write under /home/codex/repos/opensesame/ (that checkout is often mid-merge). ";
    prompt += "Do not copy node_modules or target directories. ";
    prompt += "Cargo builds must set CARGO_TARGET_DIR to the home cache at .cache/packages/cargo-target. ";
    prompt += "pnpm install must use the existing pnpm store. ";
    prompt += slice.prompt;
    jobs.push(#{
        prompt: prompt,
        label: "slice:" + slice.label,
        capability_mode: "read-write",
        output_schema: slice_schema,
    });
    i += 1;
}
let results = parallel(jobs);

let failed = 0;
for r in results {
    if r == () || r.success != true {
        failed += 1;
    }
}
log(failed.to_string() + " slice(s) failed");

phase("Verify");
let verify_prompt = "Read the git diff in " + worktree + " with git diff and git status. ";
verify_prompt += "Confirm edits stay inside that worktree. ";
verify_prompt += "Set ok true only when every intended slice is present and no file outside the worktree changed. ";
verify_prompt += "List concrete gaps otherwise. Use read-only git commands.";
let verdict = agent(verify_prompt, #{
    label: "verify-worktree",
    capability_mode: "read-only",
    output_schema: verdict_schema,
});

let verify_ok = false;
if verdict != () && verdict.success && verdict.output != () && verdict.output.ok == true {
    verify_ok = true;
}
complete(#{
    worktree: worktree,
    failed_slices: failed,
    verify_ok: verify_ok,
});
