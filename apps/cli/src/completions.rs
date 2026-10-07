//! Shell completion entries include the dedicated detection-only validator.
use crate::CompletionShell;

pub(crate) fn completion_script(shell: CompletionShell) -> &'static str {
    match shell {
        CompletionShell::Bash => {
            r#"_opensesame() { COMPREPLY=( $(compgen -W 'canary password-agent login logout status whoami auth invoke receipt doctor provider connect connection connector secret lease crypto sync export import config-files completion init config pass tui dev daemon task intent cert' -- "${COMP_WORDS[COMP_CWORD]}") ); }
complete -F _opensesame opensesame
"#
        }
        CompletionShell::Zsh => {
            r"#compdef opensesame
_arguments '1:command:(canary password-agent login logout status whoami auth invoke receipt doctor provider connect connection connector secret lease crypto sync export import config-files completion init config pass tui dev daemon task intent cert)'
"
        }
        CompletionShell::Fish => {
            r"complete -c opensesame -f -n '__fish_use_subcommand' -a 'canary password-agent login logout status whoami auth invoke receipt doctor provider connect connection connector secret lease crypto sync export import config-files completion init config pass tui dev daemon task intent cert'
"
        }
    }
}
