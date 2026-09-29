//! `opensesame-surrogate-proxy`: the optional, runtime-installed surrogate
//! proxy plugin (ADR 0150 §6.1, §7). See `opensesame_surrogate_proxy::plugin`.

fn main() -> std::process::ExitCode {
    opensesame_surrogate_proxy::plugin::main_entry()
}
