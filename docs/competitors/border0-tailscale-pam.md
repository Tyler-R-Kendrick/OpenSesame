# Border0 + Tailscale (Tailscale PAM)

Competitive reference for the **Access** screen ([ADR
0054](../adr/0054-access-screen-pam.md)). Border0 was acquired by Tailscale
(March 2026) and is shipping as **Tailscale PAM**; the classic Border0 docs
remain the most complete description of the product and are what this page
captures.

## What it is

A privileged access management (PAM) layer that sits in front of servers,
databases, Kubernetes, and internal web apps. Tailscale provides the network
(mesh WireGuard, device inventory, policy file); Border0 provides the
application-aware proxy (protocol policy, session recording, just-in-time
access). Border0's headline posture is **Zero Standing Privileges (ZSP)**:
access is requested, approved, time-bound, and recorded — never pre-granted.

## Feature surface

### Core entities (exact terminology)

- **Socket** (Tailscale-era: **Service**, `svc:<name>` tagged
  `tag:border0-managed`) — a proxied resource: HTTP(S), SSH, databases
  (Postgres, MySQL, MSSQL, MongoDB, Elasticsearch, Snowflake), Kubernetes,
  RDP, VNC, generic TCP, subnet routes, exit nodes.
- **Connector** — the in-infrastructure agent: session termination, policy
  enforcement, session recording, service discovery, secrets injection.
  Many-to-many with sockets; ≥2 recommended for HA.
- **Policy** — "enhanced firewall rules", `condition` + `permissions`,
  cumulative per socket, **default-deny**. Org-wide (auto-applies) or
  socket-specific.
- **Session** — "the connection between a user and a service": SSO identity,
  IP, geolocation, device, start/duration, recording.
- **Approval Flow** — the JIT entity: which requesters may request which
  sockets (by name or Socket Tags), which approvers decide.
- **Users vs Service Accounts** — humans vs programmatic principals.
- **Tunnel** — auto-orchestrated WireGuard between connector and device.

### Admin portal IA (portal.border0.com)

Left-hand menu: **Sockets** (inventory; "Add new Socket" opens a tile picker
of service types; per-socket detail with a Sessions tab), **Policies** (list
+ JSON editor), **Session Logs** (org-wide "who accessed what when",
click-through to replay), **Access Requests** (approval flows + submitted
requests inbox), **Connectors** (add/launch instructions), **Teams**
(service accounts).

### Client portal IA (client.border0.com)

The end-user plane: a dashboard of **app cards** with per-type icons (SSH,
database, HTTP, Postgres/MySQL/…), frequently-used pinned on top, card *and*
list views, fuzzy search, grouping by provider/environment/region,
socket-type filter, dark/light mode, and an **Access Request** tab that
appears when an approval flow applies. One-click connect: a WASM client
in-browser (web SSH, web database clients), a desktop app that launches
native clients, or a CLI.

### JIT / approval UX

Requester picks socket(s) → duration + justification → submits. Approver
gets notified (email/Slack), reviews who/what/duration/why, and at approval
time can **tune the granted permissions** (SSH only as user `support`,
read-only DB, one K8s namespace): each approval **materializes a new
fine-grained, time-bound policy**. Requester tracks status under Submitted
Access Requests. Access expires automatically. Request → granted policy →
session logs form one audit chain.

### Policy model

`condition.who` (`email`, `group`, `service_account` — OR),
`condition.where` (`allowed_ip`, `country`, `country_not` — AND),
`condition.when` (`after`/`before` absolute windows; `time_of_day_*` daily
windows). `permissions` are protocol-aware: SSH (`allowed_usernames`,
`shell`, `exec.commands` regexes, `sftp`, `tcp_forwarding`,
`kubectl_exec.allowed_namespaces`, `docker_exec.allowed_containers`,
`max_session_duration_seconds`), database (`allowed_databases` with
per-database `allowed_query_types` — ReadOnly/ReadWrite/specific verbs),
http/tls/vnc/rdp/vpn/network. Policy testing API exists.

### Session visibility

Session Logs fields: `session_id`, `socket_id`, `start_time`, `last_seen`,
`user_email`, `server_name`, `client_ip`, `session_type`, `sshuser`,
`killed`. Replay has three tabs: **Video** (movie-like), **Text** (SIEM-able
dump), **Events** (metadata incl. denied attempts and client software).
Database recordings include every executed SQL query. Admins can **kill
sessions**. Recordings downloadable; bring-your-own S3.

### Tailscale side of the parity target

- **Machines** inventory: name, managed-by (user or tags), Tailscale IPs,
  OS + client version, last seen, tags, badges (Subnets, Needs approval,
  Locked out, expiry). Rich composable filters (`property:`, `lastseen:`,
  `managedby:`, `shared:`, `disabled:`, `version:`).
- **Access controls**: one declarative tailnet policy file (HuJSON),
  visual editor or JSON; `grants`/`acls` (`src` users/groups/tags/autogroups
  → `dst host:ports`, deny-by-default), `ssh` rules (`users`,
  `checkPeriod` — **check mode** forces IdP re-auth), `tagOwners`,
  `autoApprovers`, `tests` (failing test rejects the file).
- **Device approval** / **Tailnet Lock** (signing nodes), **sharing**
  (invite links, quarantined by default), **Services** (`svc:`, TailVIP).
- **Logs**: configuration audit logs (actor/action/target/diff, 90 days);
  network flow logs opt-in.
- **Tailscale SSH**: WireGuard-key auth, two policy layers (network + ssh
  rule), revocation kills live sessions; session recording (beta) streams
  asciinema `.cast` to a self-hosted `tsrecorder`.
- Integration: Border0 connector auto-joins the tailnet; identity syncs
  from Tailscale (~20 min), Tailscale roles map to Border0 roles; the
  tailnet policy file governs reachability, Border0 policy governs
  protocol-level what.

## Differentiators

- ZSP as the default posture, not an add-on: standing access is the
  exception every flow steers away from.
- The approval → fine-grained-policy materialization: approvers don't just
  say yes, they shape the grant.
- One identity (SSO/Tailscale) end-to-end: no per-resource credentials ever
  reach the user (connector injects them).
- Session recordings as first-class evidence with three consumption modes.

## OpenSesame mapping

| Border0/Tailscale | OpenSesame |
|---|---|
| Socket / Service | Host **Connection** (ConnectionRef) — typed, sealed, egress-scoped |
| Connector | Host **gateway** + local **daemon** (invoke-through broker, materialization) |
| Policy (who/where/when + protocol permissions) | Connection **policy + bindings** + task **capability ceilings** (ADR 0019) |
| Session (+ recording) | **Task run** (standing session) + **receipts** + connection **events** + audit trail |
| Approval Flow / Access Request | **Relay authorization inbox** (ADR 0046) + **delegations** (ADR 0044) |
| Zero Standing Privileges | Frozen intent + immutable ceiling + just-in-time materialization (ADR 0018/0019/0021/0049) |
| Machines inventory | Connections inventory + discovered connections (`connection-detect`) |
| Check mode (IdP re-auth) | Step-up MFA / device ceremony on the Identity plane |
| Configuration audit logs | Identity audit events + secret changelog (ADR 0041) |
| Client portal (card dashboard, one-click connect) | Pages **Access** screen, Resources tab |
| Session Logs replay | Receipts + event stream (no video recording — honest gap, see ADR 0054 §Deviations) |

The design parity itself — tab structure, entities shown, connect and
approval UX — is specified in
[`docs/design/access-screen.md`](../design/access-screen.md).

## Sources

- docs.border0.com: Architecture and Key Concepts; Sockets; Policies;
  Sessions logs; Access Requests; Client Portal blog
  (border0.com/blogs/introducing-the-border0-client-portal)
- tailscale.com/docs/border0/*: What is Border0; Get started; Architecture
  and core concepts; Connectors
- tailscale.com: ACLs (kb/1018), Policy file syntax, Filter devices,
  Sharing (kb/1084), Device approval (kb/1099), Tailnet Lock (kb/1226),
  Tailscale SSH + session recording, Services (kb/1552), Configuration
  audit logging
- tailscale.com/blog: Border0 joins Tailscale; Tailscale PAM beta
  announcement (2026-08-27)
