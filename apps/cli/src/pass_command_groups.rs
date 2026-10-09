//! A single schema declaration keeps CLI parsing and bounded builders identical.
//! Each fixed group returns before the next is constructed; no command is run.

#[inline(never)]
pub(super) fn append<Group: clap::Subcommand>(
    command: clap::Command,
    update: bool,
) -> clap::Command {
    if update {
        Group::augment_subcommands_for_update(command)
    } else {
        Group::augment_subcommands(command)
    }
}

macro_rules! command_groups {
    (
        $visibility:vis enum $command:ident using $bounded:ident {
            $( $group:ident {
                $( $(#[$variant_metadata:meta])* $variant:ident {
                    $( $(#[$field_metadata:meta])* $field:ident: $field_type:ty ),* $(,)?
                }, )*
            } )*
        }
    ) => {
        // Keep Clap's existing extraction and update implementation on the
        // same command variants consumed by all existing dispatchers.
        #[derive(clap::Subcommand, Debug)]
        $visibility enum $command {
            $( $( $(#[$variant_metadata])* $variant {
                $( $(#[$field_metadata])* $field: $field_type, )*
            }, )* )*
        }

        $(
            #[derive(clap::Subcommand, Debug)]
            enum $group {
                $( $(#[$variant_metadata])* $variant {
                    $( $(#[$field_metadata])* $field: $field_type, )*
                }, )*
            }
        )*

        #[derive(Debug)]
        $visibility struct $bounded($command);

        impl $bounded {
            pub(crate) fn into_inner(self) -> $command { self.0 }
        }

        impl clap::FromArgMatches for $bounded {
            fn from_arg_matches(matches: &clap::ArgMatches) -> Result<Self, clap::Error> {
                <$command as clap::FromArgMatches>::from_arg_matches(matches).map(Self)
            }
            fn from_arg_matches_mut(matches: &mut clap::ArgMatches) -> Result<Self, clap::Error> {
                <$command as clap::FromArgMatches>::from_arg_matches_mut(matches).map(Self)
            }
            fn update_from_arg_matches(&mut self, matches: &clap::ArgMatches) -> Result<(), clap::Error> {
                <$command as clap::FromArgMatches>::update_from_arg_matches(&mut self.0, matches)
            }
            fn update_from_arg_matches_mut(&mut self, matches: &mut clap::ArgMatches) -> Result<(), clap::Error> {
                <$command as clap::FromArgMatches>::update_from_arg_matches_mut(&mut self.0, matches)
            }
        }

        impl clap::Subcommand for $bounded {
            #[inline(never)]
            fn augment_subcommands(command: clap::Command) -> clap::Command {
                $( let command = super::pass_command_groups::append::<$group>(command, false); )*
                command
            }

            #[inline(never)]
            fn augment_subcommands_for_update(command: clap::Command) -> clap::Command {
                $( let command = super::pass_command_groups::append::<$group>(command, true); )*
                command
            }

            fn has_subcommand(name: &str) -> bool {
                false $( || <$group as clap::Subcommand>::has_subcommand(name) )*
            }
        }
    };
}

pub(super) use command_groups;
