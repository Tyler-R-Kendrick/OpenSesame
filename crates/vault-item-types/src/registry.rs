//! The host-plane item-type registry (ADR 0087 §7).
//!
//! Built-in definitions are embedded from the shared corpus; installed ones
//! come from an operator-configured directory (`OPENSESAME_VAULT_ITEM_TYPE_DIR`)
//! or from whatever the caller hands over. Installing and uninstalling are data
//! writes: no build, no restart.
//!
//! Uninstalling never touches items. An item whose type is not installed is a
//! presentation gap, never data loss.

use std::collections::BTreeMap;
use std::path::Path;
use std::{fs, io};

use crate::schema::ItemTypeDefinition;
use crate::validate::{parse_definition, DefinitionError, DefinitionErrors, ErrorCode, Trust};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Builtin,
    Vault,
    Host,
}

#[derive(Clone, Debug)]
pub struct Registered {
    pub definition: ItemTypeDefinition,
    pub source: Source,
}

#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error("reading {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: io::Error,
    },
    #[error("{path} is not a valid item type definition:\n{source}")]
    Invalid {
        path: String,
        #[source]
        source: DefinitionErrors,
    },
}

fn refusal(code: ErrorCode, path: &str, message: impl Into<String>) -> DefinitionErrors {
    DefinitionErrors(vec![DefinitionError {
        code,
        path: path.to_owned(),
        message: message.into(),
    }])
}

/// Directory names the vault rail draws that are not a type's own: the fixed
/// filters beside the type directories, and the short names the rail gives
/// platform kinds whose plurals would read differently (`certs`, `notes`). An
/// install may not claim one, or its items would share a directory with
/// something else.
pub const RESERVED_DIRECTORIES: [&str; 5] = ["all", "favorites", "trash", "certs", "notes"];

/// Ids no type may take. A type id is also the vault's `?f=` filter value, and
/// these three already mean something there: a type called `favorites` would
/// have a directory that opens the favorites instead.
pub const RESERVED_TYPE_IDS: [&str; 3] = ["all", "favorites", "trash"];

/// The vault directory a type's items live under: its plural as a path
/// segment (`Wi-Fi networks` → `wi-fi-networks`). ASCII-only, byte for byte
/// the TypeScript derivation; a plural with no ASCII letter or digit falls
/// back to the type id, which is already a segment.
#[must_use]
pub fn directory_name(definition: &ItemTypeDefinition) -> String {
    let mut slug = String::with_capacity(definition.spec.plural.len());
    for ch in definition.spec.plural.chars() {
        let ch = ch.to_ascii_lowercase();
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            slug.push(ch);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        definition.metadata.id.clone()
    } else {
        slug.to_owned()
    }
}

/// How two titles are compared: case and surrounding ASCII space never count.
/// ASCII only, because `str::trim` and JavaScript's `trim` disagree about
/// U+FEFF, and the two planes must refuse the same installs.
fn title_key(title: &str) -> String {
    title
        .trim_matches(|c: char| c.is_ascii_whitespace())
        .to_lowercase()
}

fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let parse = |value: &str| -> Vec<u64> {
        value
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (l, r) = (parse(left), parse(right));
    for index in 0..3 {
        let a = l.get(index).copied().unwrap_or(0);
        let b = r.get(index).copied().unwrap_or(0);
        if a != b {
            return a.cmp(&b);
        }
    }
    std::cmp::Ordering::Equal
}

#[derive(Clone, Debug, Default)]
pub struct ItemTypeRegistry {
    builtin: BTreeMap<String, ItemTypeDefinition>,
    installed: BTreeMap<String, Registered>,
}

impl ItemTypeRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// A registry holding the embedded corpus and nothing else.
    ///
    /// # Panics
    ///
    /// Panics if a built-in definition does not parse. That is a build error,
    /// not a runtime state: the corpus ships with the binary and
    /// `tests/conformance.rs` parses every file.
    #[must_use]
    pub fn with_builtins() -> Self {
        let mut registry = Self::new();
        for (id, text) in crate::BUILTIN_DEFINITIONS {
            let definition = parse_definition(text, Trust::Platform)
                .unwrap_or_else(|errors| panic!("built-in item type `{id}` is invalid:\n{errors}"));
            assert_eq!(
                definition.metadata.id, *id,
                "built-in file `{id}.json` declares a different id"
            );
            registry.builtin.insert((*id).to_owned(), definition);
        }
        registry
    }

    /// Install a definition from JSON text.
    ///
    /// A built-in id may not be shadowed and a publisher may not take over an
    /// id another publisher installed: identity is `publisher + id`, never a
    /// bare name a later install can redefine underneath existing items.
    ///
    /// # Errors
    ///
    /// Returns the parse refusals, or a single refusal naming the ownership or
    /// version rule the install broke.
    pub fn install(
        &mut self,
        text: &str,
        source: Source,
    ) -> Result<ItemTypeDefinition, DefinitionErrors> {
        let trust = if source == Source::Builtin {
            Trust::Platform
        } else {
            Trust::Community
        };
        let definition = parse_definition(text, trust)?;
        let id = definition.metadata.id.clone();
        if source == Source::Builtin {
            self.builtin.insert(id, definition.clone());
            return Ok(definition);
        }
        if RESERVED_TYPE_IDS.contains(&id.as_str()) {
            return Err(refusal(
                ErrorCode::Id,
                "metadata.id",
                format!("`{id}` is a vault filter and cannot name a type"),
            ));
        }
        if self.builtin.contains_key(&id) {
            return Err(refusal(
                ErrorCode::Id,
                "metadata.id",
                format!("`{id}` is a built-in type and cannot be redefined"),
            ));
        }
        // The VFS tree renders an item as `name.ext`, so the extension is the
        // second thing that identifies a type on screen. Letting an install
        // claim `.login` would let it dress its items as logins.
        if let Some(clash) = self.extension_owner(&definition.spec.extension, &id) {
            return Err(refusal(
                ErrorCode::Extension,
                "spec.extension",
                format!(
                    "`{}` is already used by `{clash}`",
                    definition.spec.extension
                ),
            ));
        }
        if let Some(clash) = self.name_clash(&definition) {
            return Err(clash);
        }
        if let Some(current) = self.installed.get(&id) {
            if current.definition.metadata.publisher != definition.metadata.publisher {
                return Err(refusal(
                    ErrorCode::Publisher,
                    "metadata.publisher",
                    format!(
                        "`{id}` is already installed from {}",
                        current.definition.metadata.publisher
                    ),
                ));
            }
            if compare_versions(
                &definition.metadata.version,
                &current.definition.metadata.version,
            ) == std::cmp::Ordering::Less
            {
                return Err(refusal(
                    ErrorCode::Version,
                    "metadata.version",
                    format!(
                        "`{id}` is already installed at {}",
                        current.definition.metadata.version
                    ),
                ));
            }
        }
        self.installed.insert(
            id,
            Registered {
                definition: definition.clone(),
                source,
            },
        );
        Ok(definition)
    }

    /// Load every `*.json` in a directory as a host-provisioned definition.
    ///
    /// # Errors
    ///
    /// Returns the first unreadable or invalid file. A directory that does not
    /// exist is not an error — the host simply provisions no types.
    pub fn load_directory(&mut self, dir: &Path) -> Result<usize, LoadError> {
        if !dir.is_dir() {
            return Ok(0);
        }
        let mut names: Vec<_> = fs::read_dir(dir)
            .map_err(|source| LoadError::Io {
                path: dir.display().to_string(),
                source,
            })?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .collect();
        names.sort();

        let mut loaded = 0usize;
        for path in names {
            let text = fs::read_to_string(&path).map_err(|source| LoadError::Io {
                path: path.display().to_string(),
                source,
            })?;
            self.install(&text, Source::Host)
                .map_err(|source| LoadError::Invalid {
                    path: path.display().to_string(),
                    source,
                })?;
            loaded += 1;
        }
        Ok(loaded)
    }

    /// Every registered type is one directory in the vault and one name in the
    /// type picker, so an install may not reuse another type's title or
    /// directory, nor a directory the rail keeps for itself. Two types sharing
    /// either would draw as one, and their items would be indistinguishable.
    fn name_clash(&self, definition: &ItemTypeDefinition) -> Option<DefinitionErrors> {
        let self_id = definition.metadata.id.as_str();
        let directory = directory_name(definition);
        if RESERVED_DIRECTORIES.contains(&directory.as_str()) {
            return Some(refusal(
                ErrorCode::Name,
                "spec.plural",
                format!("`{directory}` is a reserved vault directory"),
            ));
        }
        let title = title_key(&definition.spec.title);
        let others = self
            .builtin
            .values()
            .chain(self.installed.values().map(|entry| &entry.definition))
            .filter(|other| other.metadata.id != self_id);
        for other in others {
            if title_key(&other.spec.title) == title {
                return Some(refusal(
                    ErrorCode::Name,
                    "spec.title",
                    format!(
                        "`{}` is already the title of `{}`",
                        definition.spec.title, other.metadata.id
                    ),
                ));
            }
            if directory_name(other) == directory {
                return Some(refusal(
                    ErrorCode::Name,
                    "spec.plural",
                    format!(
                        "`{directory}` is already the directory of `{}`",
                        other.metadata.id
                    ),
                ));
            }
        }
        None
    }

    /// The type already rendering this extension, if it is not `self_id`.
    fn extension_owner(&self, extension: &str, self_id: &str) -> Option<String> {
        self.builtin
            .iter()
            .map(|(id, definition)| (id, &definition.spec.extension))
            .chain(
                self.installed
                    .iter()
                    .map(|(id, entry)| (id, &entry.definition.spec.extension)),
            )
            .find(|(id, ext)| id.as_str() != self_id && ext.as_str() == extension)
            .map(|(id, _)| id.clone())
    }

    /// Remove an installed definition. Items of that type are left alone.
    pub fn uninstall(&mut self, id: &str) -> bool {
        self.installed.remove(id).is_some()
    }

    #[must_use]
    pub fn get(&self, id: &str) -> Option<&ItemTypeDefinition> {
        self.builtin
            .get(id)
            .or_else(|| self.installed.get(id).map(|entry| &entry.definition))
    }

    #[must_use]
    pub fn has(&self, id: &str) -> bool {
        self.get(id).is_some()
    }

    #[must_use]
    pub fn is_builtin(&self, id: &str) -> bool {
        self.builtin.contains_key(id)
    }

    #[must_use]
    pub fn source_of(&self, id: &str) -> Option<Source> {
        if self.builtin.contains_key(id) {
            return Some(Source::Builtin);
        }
        self.installed.get(id).map(|entry| entry.source)
    }

    /// Every registered type, built-ins first, each group by title.
    #[must_use]
    pub fn list(&self) -> Vec<Registered> {
        let mut builtins: Vec<Registered> = self
            .builtin
            .values()
            .map(|definition| Registered {
                definition: definition.clone(),
                source: Source::Builtin,
            })
            .collect();
        let mut installed: Vec<Registered> = self.installed.values().cloned().collect();
        builtins.sort_by(|a, b| a.definition.spec.title.cmp(&b.definition.spec.title));
        installed.sort_by(|a, b| a.definition.spec.title.cmp(&b.definition.spec.title));
        builtins.extend(installed);
        builtins
    }
}
