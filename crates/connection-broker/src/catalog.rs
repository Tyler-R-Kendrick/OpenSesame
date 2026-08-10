//! Provider catalog: data, not code paths (ADR 0032 §3).
//!
//! Every entry declares its endpoints, its scope vocabulary and — the part the
//! rest of the system depends on — the egress allowlist a credential issued for
//! it may reach. Endpoints are copied from provider documentation; a provider
//! whose endpoints are not known belongs outside this table.

use opensesame_domain::EgressBinding;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Developer,
    Productivity,
    Communication,
    Storage,
    Crm,
    Payments,
    Identity,
    Testing,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Developer => "developer",
            Self::Productivity => "productivity",
            Self::Communication => "communication",
            Self::Storage => "storage",
            Self::Crm => "crm",
            Self::Payments => "payments",
            Self::Identity => "identity",
            Self::Testing => "testing",
        }
    }
}

/// How the token endpoint authenticates the client.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenAuth {
    ClientSecretPost,
    ClientSecretBasic,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthMethod {
    OAuth2AuthCode {
        authorize_url: &'static str,
        token_url: &'static str,
        revoke_url: Option<&'static str>,
        supports_refresh: bool,
        token_auth: TokenAuth,
        /// Provider-specific parameters without which a refresh token is never
        /// issued (Google's `access_type`, the `offline_access` family).
        extra_authorize_params: &'static [(&'static str, &'static str)],
    },
    ApiKey {
        header: &'static str,
        value_prefix: &'static str,
    },
}

impl AuthMethod {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::OAuth2AuthCode { .. } => "oauth2_authorization_code",
            Self::ApiKey { .. } => "api_key",
        }
    }

    pub fn supports_refresh(&self) -> bool {
        matches!(
            self,
            Self::OAuth2AuthCode {
                supports_refresh: true,
                ..
            }
        )
    }

    pub fn is_oauth(&self) -> bool {
        matches!(self, Self::OAuth2AuthCode { .. })
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct ScopeDef {
    pub name: &'static str,
    pub description: &'static str,
    /// Broad or destructive: the UI must not pre-tick these silently.
    pub sensitive: bool,
    pub default: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct EgressSpec {
    pub scheme: &'static str,
    pub authorities: &'static [&'static str],
    pub path_prefixes: &'static [&'static str],
}

impl EgressSpec {
    pub fn binding(&self) -> EgressBinding {
        EgressBinding {
            scheme: self.scheme.to_string(),
            authorities: self.authorities.iter().map(|a| a.to_string()).collect(),
            path_prefixes: self.path_prefixes.iter().map(|p| p.to_string()).collect(),
            allow_redirects_cross_authority: false,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Provider {
    pub id: &'static str,
    pub display_name: &'static str,
    pub category: Category,
    pub docs_url: &'static str,
    pub auth: AuthMethod,
    pub scopes: &'static [ScopeDef],
    pub egress: EgressSpec,
    pub operations: &'static [&'static str],
}

impl Provider {
    pub fn default_scopes(&self) -> Vec<String> {
        self.scopes
            .iter()
            .filter(|s| s.default)
            .map(|s| s.name.to_string())
            .collect()
    }
}

pub fn find(id: &str) -> Option<&'static Provider> {
    PROVIDERS.iter().find(|p| p.id == id)
}

pub fn all() -> &'static [Provider] {
    PROVIDERS
}

/// Loopback default for the bundled mock authorization server; overridden per
/// deployment by `OPENSESAME_PROVIDER_MOCK_AUTHORIZE_URL` / `_TOKEN_URL`.
pub const MOCK_AUTHORIZE_URL: &str = "http://127.0.0.1:9090/authorize";
pub const MOCK_TOKEN_URL: &str = "http://127.0.0.1:9090/token";

const OFFLINE_ACCESS: &[(&str, &str)] = &[];

static PROVIDERS: &[Provider] = &[
    Provider {
        id: "github",
        display_name: "GitHub",
        category: Category::Developer,
        docs_url: "https://docs.github.com/apps/oauth-apps",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://github.com/login/oauth/authorize",
            token_url: "https://github.com/login/oauth/access_token",
            revoke_url: None,
            supports_refresh: false,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "read:user",
                description: "Read the authenticated user's profile",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "repo",
                description: "Full read and write access to private repositories",
                sensitive: true,
                default: false,
            },
            ScopeDef {
                name: "read:org",
                description: "Read organization membership and teams",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "workflow",
                description: "Update GitHub Actions workflow files",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.github.com"],
            path_prefixes: &[],
        },
        operations: &["repository.read", "pull_request.create", "issue.create"],
    },
    Provider {
        id: "gitlab",
        display_name: "GitLab",
        category: Category::Developer,
        docs_url: "https://docs.gitlab.com/ee/api/oauth2.html",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://gitlab.com/oauth/authorize",
            token_url: "https://gitlab.com/oauth/token",
            revoke_url: Some("https://gitlab.com/oauth/revoke"),
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "read_user",
                description: "Read the authenticated user's profile",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "read_repository",
                description: "Read repository files and metadata",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "api",
                description: "Full read and write access to the GitLab API",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["gitlab.com"],
            path_prefixes: &[],
        },
        operations: &["project.read", "merge_request.create", "issue.create"],
    },
    Provider {
        id: "google",
        display_name: "Google",
        category: Category::Productivity,
        docs_url: "https://developers.google.com/identity/protocols/oauth2/web-server",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
            token_url: "https://oauth2.googleapis.com/token",
            revoke_url: Some("https://oauth2.googleapis.com/revoke"),
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            // Google issues a refresh token only on the first consent unless both are sent.
            extra_authorize_params: &[("access_type", "offline"), ("prompt", "consent")],
        },
        scopes: &[
            ScopeDef {
                name: "openid",
                description: "Identify the signed-in account",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "email",
                description: "Read the account's email address",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "https://www.googleapis.com/auth/drive.readonly",
                description: "Read all files in Google Drive",
                sensitive: true,
                default: false,
            },
            ScopeDef {
                name: "https://www.googleapis.com/auth/gmail.readonly",
                description: "Read all Gmail messages and settings",
                sensitive: true,
                default: false,
            },
            ScopeDef {
                name: "https://www.googleapis.com/auth/calendar.readonly",
                description: "Read calendars and events",
                sensitive: false,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &[
                "www.googleapis.com",
                "gmail.googleapis.com",
                "oauth2.googleapis.com",
            ],
            path_prefixes: &[],
        },
        operations: &[
            "drive.file.read",
            "gmail.message.read",
            "calendar.event.read",
        ],
    },
    Provider {
        id: "microsoft",
        display_name: "Microsoft",
        category: Category::Productivity,
        docs_url: "https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            revoke_url: None,
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "offline_access",
                description: "Keep access when the user is not present (refresh token)",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "User.Read",
                description: "Read the signed-in user's profile",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "Mail.Read",
                description: "Read the signed-in user's mail",
                sensitive: true,
                default: false,
            },
            ScopeDef {
                name: "Files.Read.All",
                description: "Read all files the signed-in user can access",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["graph.microsoft.com"],
            path_prefixes: &[],
        },
        operations: &["user.read", "mail.message.read", "drive.file.read"],
    },
    Provider {
        id: "slack",
        display_name: "Slack",
        category: Category::Communication,
        docs_url: "https://api.slack.com/authentication/oauth-v2",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://slack.com/oauth/v2/authorize",
            token_url: "https://slack.com/api/oauth.v2.access",
            revoke_url: None,
            supports_refresh: false,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "chat:write",
                description: "Post messages as the app",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "channels:read",
                description: "List public channels and their metadata",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "users:read",
                description: "List workspace members",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "files:read",
                description: "Read files shared in the workspace",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["slack.com"],
            path_prefixes: &[],
        },
        operations: &["message.post", "channel.list", "user.list"],
    },
    Provider {
        id: "notion",
        display_name: "Notion",
        category: Category::Productivity,
        docs_url: "https://developers.notion.com/docs/authorization",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://api.notion.com/v1/oauth/authorize",
            token_url: "https://api.notion.com/v1/oauth/token",
            revoke_url: None,
            supports_refresh: false,
            token_auth: TokenAuth::ClientSecretBasic,
            extra_authorize_params: &[("owner", "user")],
        },
        // Notion grants capabilities per integration at consent time and rejects a
        // `scope` parameter, so there is no scope vocabulary to offer here.
        scopes: &[],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.notion.com"],
            path_prefixes: &[],
        },
        operations: &["page.read", "database.query", "page.create"],
    },
    Provider {
        id: "linear",
        display_name: "Linear",
        category: Category::Productivity,
        docs_url: "https://developers.linear.app/docs/oauth/authentication",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://linear.app/oauth/authorize",
            token_url: "https://api.linear.app/oauth/token",
            revoke_url: Some("https://api.linear.app/oauth/revoke"),
            supports_refresh: false,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "read",
                description: "Read issues, projects and teams",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "write",
                description: "Create and update issues and comments",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "issues:create",
                description: "Create issues only",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "admin",
                description: "Full administrative access to the workspace",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.linear.app"],
            path_prefixes: &[],
        },
        operations: &["issue.read", "issue.create", "project.read"],
    },
    Provider {
        id: "atlassian",
        display_name: "Atlassian",
        category: Category::Productivity,
        docs_url: "https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://auth.atlassian.com/authorize",
            token_url: "https://auth.atlassian.com/oauth/token",
            revoke_url: None,
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            // Atlassian requires an explicit audience and consent prompt on 3LO.
            extra_authorize_params: &[("audience", "api.atlassian.com"), ("prompt", "consent")],
        },
        scopes: &[
            ScopeDef {
                name: "offline_access",
                description: "Keep access when the user is not present (refresh token)",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "read:me",
                description: "Read the authenticated user's profile",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "read:jira-work",
                description: "Read Jira issues, projects and worklogs",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "write:jira-work",
                description: "Create and update Jira issues",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.atlassian.com"],
            path_prefixes: &[],
        },
        operations: &["issue.read", "issue.create", "project.read"],
    },
    Provider {
        id: "hubspot",
        display_name: "HubSpot",
        category: Category::Crm,
        docs_url: "https://developers.hubspot.com/docs/api/working-with-oauth",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://app.hubspot.com/oauth/authorize",
            token_url: "https://api.hubapi.com/oauth/v1/token",
            revoke_url: None,
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "oauth",
                description: "Identify the connected HubSpot account",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "crm.objects.contacts.read",
                description: "Read contact records",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "crm.objects.contacts.write",
                description: "Create and update contact records",
                sensitive: true,
                default: false,
            },
            ScopeDef {
                name: "crm.objects.deals.read",
                description: "Read deal records",
                sensitive: false,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.hubapi.com"],
            path_prefixes: &[],
        },
        operations: &["contact.read", "contact.create", "deal.read"],
    },
    Provider {
        id: "salesforce",
        display_name: "Salesforce",
        category: Category::Crm,
        docs_url:
            "https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://login.salesforce.com/services/oauth2/authorize",
            token_url: "https://login.salesforce.com/services/oauth2/token",
            revoke_url: Some("https://login.salesforce.com/services/oauth2/revoke"),
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "api",
                description: "Access and manage data through the Salesforce APIs",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "refresh_token",
                description: "Keep access when the user is not present (refresh token)",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "openid",
                description: "Identify the signed-in user",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "full",
                description: "Full access to all data the user can reach",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["login.salesforce.com"],
            path_prefixes: &[],
        },
        operations: &["record.read", "record.create", "soql.query"],
    },
    Provider {
        id: "zoom",
        display_name: "Zoom",
        category: Category::Communication,
        docs_url: "https://developers.zoom.us/docs/integrations/oauth/",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://zoom.us/oauth/authorize",
            token_url: "https://zoom.us/oauth/token",
            revoke_url: Some("https://zoom.us/oauth/revoke"),
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretBasic,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "user:read",
                description: "Read the authenticated user's profile",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "meeting:read",
                description: "Read the user's meetings",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "meeting:write",
                description: "Create, update and delete meetings",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.zoom.us"],
            path_prefixes: &[],
        },
        operations: &["meeting.read", "meeting.create", "user.read"],
    },
    Provider {
        id: "dropbox",
        display_name: "Dropbox",
        category: Category::Storage,
        docs_url: "https://developers.dropbox.com/oauth-guide",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://www.dropbox.com/oauth2/authorize",
            token_url: "https://api.dropboxapi.com/oauth2/token",
            revoke_url: None,
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            // Dropbox returns a refresh token only for offline token access.
            extra_authorize_params: &[("token_access_type", "offline")],
        },
        scopes: &[
            ScopeDef {
                name: "account_info.read",
                description: "Read the connected account's profile",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "files.metadata.read",
                description: "List files and folders",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "files.content.read",
                description: "Download file contents",
                sensitive: true,
                default: false,
            },
            ScopeDef {
                name: "files.content.write",
                description: "Upload, edit and delete files",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.dropboxapi.com", "content.dropboxapi.com"],
            path_prefixes: &[],
        },
        operations: &["file.list", "file.read", "file.write"],
    },
    Provider {
        id: "box",
        display_name: "Box",
        category: Category::Storage,
        docs_url: "https://developer.box.com/guides/authentication/oauth2/",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://account.box.com/api/oauth2/authorize",
            token_url: "https://api.box.com/oauth2/token",
            revoke_url: Some("https://api.box.com/oauth2/revoke"),
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "root_readonly",
                description: "Read all files and folders in the account",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "root_readwrite",
                description: "Read, write and delete all files and folders",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.box.com"],
            path_prefixes: &[],
        },
        operations: &["file.list", "file.read", "file.write"],
    },
    Provider {
        id: "asana",
        display_name: "Asana",
        category: Category::Productivity,
        docs_url: "https://developers.asana.com/docs/oauth",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://app.asana.com/-/oauth_authorize",
            token_url: "https://app.asana.com/-/oauth_token",
            revoke_url: None,
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "default",
                description: "Full access to everything the authorizing user can reach",
                sensitive: true,
                default: true,
            },
            ScopeDef {
                name: "openid",
                description: "Identify the authorizing user",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "email",
                description: "Read the authorizing user's email address",
                sensitive: false,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["app.asana.com"],
            path_prefixes: &[],
        },
        operations: &["task.read", "task.create", "project.read"],
    },
    Provider {
        id: "figma",
        display_name: "Figma",
        category: Category::Productivity,
        docs_url: "https://www.figma.com/developers/api#oauth2",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://www.figma.com/oauth",
            token_url: "https://api.figma.com/v1/oauth/token",
            revoke_url: None,
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretBasic,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "files:read",
                description: "Read files, projects and components",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "file_comments:write",
                description: "Post comments on files",
                sensitive: false,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.figma.com"],
            path_prefixes: &[],
        },
        operations: &["file.read", "comment.create"],
    },
    Provider {
        id: "discord",
        display_name: "Discord",
        category: Category::Communication,
        docs_url: "https://discord.com/developers/docs/topics/oauth2",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://discord.com/oauth2/authorize",
            token_url: "https://discord.com/api/oauth2/token",
            revoke_url: Some("https://discord.com/api/oauth2/token/revoke"),
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretBasic,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "identify",
                description: "Read the authorizing user's account",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "email",
                description: "Read the authorizing user's email address",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "guilds",
                description: "List the guilds the user belongs to",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "bot",
                description: "Add a bot to a guild with the requested permissions",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["discord.com"],
            path_prefixes: &[],
        },
        operations: &["user.read", "guild.list", "message.post"],
    },
    Provider {
        id: "sentry",
        display_name: "Sentry",
        category: Category::Developer,
        docs_url: "https://docs.sentry.io/api/guides/create-auth-token/",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: "https://sentry.io/oauth/authorize/",
            token_url: "https://sentry.io/oauth/token/",
            revoke_url: None,
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "org:read",
                description: "Read organization settings and membership",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "project:read",
                description: "Read project settings",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "event:read",
                description: "Read error events and issues",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "project:write",
                description: "Create and modify projects",
                sensitive: true,
                default: false,
            },
        ],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["sentry.io"],
            path_prefixes: &[],
        },
        operations: &["issue.read", "event.read", "project.read"],
    },
    Provider {
        id: "stripe",
        display_name: "Stripe",
        category: Category::Payments,
        docs_url: "https://docs.stripe.com/keys",
        auth: AuthMethod::ApiKey {
            header: "Authorization",
            value_prefix: "Bearer ",
        },
        scopes: &[],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.stripe.com"],
            path_prefixes: &[],
        },
        operations: &["customer.read", "charge.read", "invoice.read"],
    },
    Provider {
        id: "openai",
        display_name: "OpenAI",
        category: Category::Developer,
        docs_url: "https://platform.openai.com/docs/api-reference/authentication",
        auth: AuthMethod::ApiKey {
            header: "Authorization",
            value_prefix: "Bearer ",
        },
        scopes: &[],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.openai.com"],
            path_prefixes: &[],
        },
        operations: &["completion.create", "embedding.create", "model.list"],
    },
    Provider {
        id: "anthropic",
        display_name: "Anthropic",
        category: Category::Developer,
        docs_url: "https://docs.anthropic.com/en/api/getting-started",
        auth: AuthMethod::ApiKey {
            header: "x-api-key",
            value_prefix: "",
        },
        scopes: &[],
        egress: EgressSpec {
            scheme: "https",
            authorities: &["api.anthropic.com"],
            path_prefixes: &[],
        },
        operations: &["message.create", "model.list"],
    },
    Provider {
        id: "mock",
        display_name: "Mock provider (testing)",
        category: Category::Testing,
        docs_url: "https://github.com/Tyler-R-Kendrick/OpenSesame/tree/main/apps/mock-upstream-idp",
        auth: AuthMethod::OAuth2AuthCode {
            authorize_url: MOCK_AUTHORIZE_URL,
            token_url: MOCK_TOKEN_URL,
            revoke_url: None,
            supports_refresh: true,
            token_auth: TokenAuth::ClientSecretPost,
            extra_authorize_params: OFFLINE_ACCESS,
        },
        scopes: &[
            ScopeDef {
                name: "read",
                description: "Read fixtures from the mock upstream",
                sensitive: false,
                default: true,
            },
            ScopeDef {
                name: "write",
                description: "Write fixtures to the mock upstream",
                sensitive: false,
                default: false,
            },
            ScopeDef {
                name: "offline_access",
                description: "Keep access when the user is not present (refresh token)",
                sensitive: false,
                default: true,
            },
        ],
        egress: EgressSpec {
            scheme: "http",
            authorities: &["127.0.0.1"],
            path_prefixes: &[],
        },
        operations: &["fixture.read", "fixture.write"],
    },
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn provider_ids_are_unique_and_lookupable() {
        let mut seen = HashSet::new();
        for p in all() {
            assert!(seen.insert(p.id), "duplicate provider id {}", p.id);
            assert_eq!(find(p.id).map(|f| f.id), Some(p.id));
        }
        assert!(find("nope").is_none());
    }

    #[test]
    fn every_provider_has_an_egress_allowlist() {
        for p in all() {
            assert!(
                !p.egress.authorities.is_empty(),
                "{} has no egress authority; a credential for it could go anywhere",
                p.id
            );
            assert!(!p.operations.is_empty(), "{} declares no operations", p.id);
            assert!(!p.display_name.is_empty());
            assert!(p.docs_url.starts_with("https://"), "{}", p.id);
        }
    }

    /// Only the loopback mock may speak cleartext; everything else is https.
    #[test]
    fn endpoints_are_https_except_the_mock() {
        for p in all() {
            if let AuthMethod::OAuth2AuthCode {
                authorize_url,
                token_url,
                revoke_url,
                ..
            } = p.auth
            {
                let expect_https = p.id != "mock";
                for url in [Some(authorize_url), Some(token_url), revoke_url]
                    .into_iter()
                    .flatten()
                {
                    if expect_https {
                        assert!(url.starts_with("https://"), "{} endpoint {url}", p.id);
                    } else {
                        assert!(url.starts_with("http://127.0.0.1"), "{url}");
                    }
                }
            }
            if p.id == "mock" {
                assert_eq!(p.egress.scheme, "http");
            } else {
                assert_eq!(p.egress.scheme, "https", "{}", p.id);
            }
        }
    }

    #[test]
    fn scopes_are_described_and_defaults_are_not_sensitive() {
        for p in all() {
            let mut names = HashSet::new();
            for s in p.scopes {
                assert!(names.insert(s.name), "{} repeats scope {}", p.id, s.name);
                assert!(!s.description.is_empty(), "{}/{}", p.id, s.name);
            }
            // Asana's only scope is its all-or-nothing `default`; everywhere else a
            // pre-ticked scope must be a narrow one.
            if p.id != "asana" {
                assert!(
                    p.scopes.iter().filter(|s| s.default).all(|s| !s.sensitive),
                    "{} pre-selects a sensitive scope",
                    p.id
                );
            }
        }
    }

    #[test]
    fn api_key_providers_declare_a_header() {
        for p in all() {
            if let AuthMethod::ApiKey { header, .. } = p.auth {
                assert!(!header.is_empty(), "{}", p.id);
                assert!(p.scopes.is_empty(), "{} is api_key yet lists scopes", p.id);
                assert!(!p.auth.supports_refresh());
            }
        }
    }

    #[test]
    fn egress_binding_denies_other_authorities() {
        let github = find("github").expect("github");
        let egress = github.egress.binding();
        assert!(egress.allows_url("https://api.github.com/user").is_ok());
        assert!(egress.allows_url("https://evil.example/user").is_err());
    }
}
