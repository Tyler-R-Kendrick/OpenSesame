export const DOCUMENTED_PROBE_REPLIES = {
  polar: {
    items: [
      {
        id: "org_protocol",
        name: "Protocol authority organization",
        slug: "protocol-authority",
      },
    ],
  },
  higgsfield: { status: "completed", request_id: "contract-request_id" },
  "fal-ai": { status: "COMPLETED", request_id: "contract-request_id" },
  // https://github.com/coddingtonbear/obsidian-local-rest-api#rest-api
  obsidian: [],
  // https://docs.linqapp.com/api-reference/phone-numbers/list-phone-numbers
  linq: {
    phone_numbers: [
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        phone_number: "+12025551234",
        line_type: "iMessage",
        forwarding_number: "+12025559999",
        reputation: {
          status: "HEALTHY",
          doc_url:
            "https://docs.linqapp.com/channel/imessage/guides/phone-numbers/phone-reputation#healthy",
        },
        private_metadata: "private Linq upstream metadata",
      },
    ],
  },
  // https://docs.agentmail.to/api-reference/inboxes/list
  agentmail: {
    count: 1,
    inboxes: [
      {
        inbox_id: "owned-inbox",
        email: "owned@example.test",
        display_name: "Protocol authority AgentMail inbox",
      },
    ],
  },
  algolia: {
    items: [
      {
        name: "products",
        entries: 1,
        dataSize: 128,
        lastBuildTimeS: 1,
        pendingTask: false,
        primary: true,
      },
    ],
    nbPages: 1,
  },
  anthropic: {
    data: [
      {
        id: "claude-contract",
        type: "model",
        display_name: "Protocol authority model",
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
    has_more: false,
    first_id: "claude-contract",
    last_id: "claude-contract",
  },
  notion: {
    object: "user",
    id: "11111111-1111-4111-8111-111111111111",
    type: "bot",
    name: "Protocol authority Notion bot",
    bot: {
      owner: { type: "workspace", workspace: true },
      workspace_name: "Protocol authority workspace",
    },
  },
  resend: {
    data: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "contract.example.test",
        status: "verified",
        region: "us-east-1",
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
    has_more: false,
  },
  postmark: {
    ID: 42,
    Name: "Protocol authority Postmark server",
    ServerLink: "https://account.postmarkapp.com/servers/42",
    DeliveryType: "Live",
    ApiTokens: [],
  },
  gemini: {
    models: [
      {
        name: "models/gemini-contract",
        version: "001",
        displayName: "Protocol authority Gemini model",
        supportedGenerationMethods: ["generateContent"],
      },
    ],
  },
};

export const DOCUMENTED_READS = {
  clickup: {
    id: "provider.workspaces.read",
    label: "List workspaces",
    method: "GET",
    url: "https://api.clickup.com/api/v2/team",
    headers: {},
    reply: { teams: [{ id: "7", name: "Protocol workspace" }] },
    result: {
      label: "Showing 1 of 1 returned workspaces",
      items: [{ id: "7", label: "Protocol workspace" }],
    },
    excludedText: [],
  },
  cloudflare: {
    id: "provider.zones.read",
    label: "List zones",
    method: "GET",
    url: "https://api.cloudflare.com/client/v4/zones?page=1&per_page=20",
    headers: {},
    reply: {
      success: true,
      result: [{ id: "zone-1", name: "example.test" }],
      result_info: {
        page: 1,
        per_page: 20,
        count: 1,
        total_count: 1,
        total_pages: 1,
      },
      errors: [],
    },
    result: {
      label: "Showing 1 zone from first page",
      items: [{ id: "zone-1", label: "example.test" }],
    },
    excludedText: [],
  },
  gitlab: {
    id: "provider.projects.read",
    label: "List membership projects",
    method: "GET",
    url: "https://gitlab.com/api/v4/projects?membership=true&simple=true&per_page=20&page=1",
    headers: {},
    reply: [{ id: 7, name: "Protocol project" }],
    result: {
      label: "Showing 1 membership projects from first page",
      items: [{ id: "7", label: "Protocol project" }],
    },
    excludedText: [],
  },
  lemma: {
    id: "provider.entities.read",
    label: "List entities",
    method: "GET",
    url: "https://api.getlemma.com/v0/entities",
    headers: {},
    reply: {
      data: [{ id: "entity_1", name: "Protocol entity" }],
      has_next: false,
      cursor: null,
    },
    result: {
      label: "Showing 1 entities from first page",
      items: [{ id: "entity_1", label: "Protocol entity" }],
    },
    excludedText: [],
  },
  neon: {
    id: "provider.projects.read",
    label: "List projects",
    method: "GET",
    url: "https://console.neon.tech/api/v2/projects?limit=20&org_id=contract-org_id",
    headers: {},
    reply: {
      projects: [
        {
          id: "project-1",
          name: "Protocol project",
          org_id: "contract-org_id",
        },
      ],
    },
    result: {
      label: "Showing 1 projects from first page",
      items: [{ id: "project-1", label: "Protocol project" }],
    },
    excludedText: [],
  },
  pinecone: {
    id: "provider.indexes.read",
    label: "List indexes",
    method: "GET",
    url: "https://api.pinecone.io/indexes",
    headers: { "X-Pinecone-API-Version": "2025-04" },
    reply: { indexes: [{ name: "index-1" }] },
    result: {
      label: "Showing 1 of 1 returned indexes",
      items: [{ id: "index-1", label: "index-1" }],
    },
    excludedText: [],
  },
  n8n: {
    id: "provider.workflows.read",
    label: "List workflows",
    method: "GET",
    url: "https://contractinstance.app.n8n.cloud/api/v1/workflows?limit=20&excludePinnedData=true",
    headers: {},
    reply: { data: [{ id: "workflow-1", name: "Protocol workflow" }] },
    result: {
      label: "Showing 1 workflows from first page",
      items: [{ id: "workflow-1", label: "Protocol workflow" }],
    },
    excludedText: [],
  },
  sendgrid: {
    id: "provider.marketing-lists.read",
    label: "List marketing lists",
    method: "GET",
    url: "https://api.sendgrid.com/v3/marketing/lists?page_size=20",
    headers: {},
    reply: {
      result: [
        { id: "11111111-1111-4111-8111-111111111111", name: "Protocol list" },
      ],
      _metadata: { count: 1 },
    },
    result: {
      label: "Showing 1 marketing lists from first page",
      items: [
        { id: "11111111-1111-4111-8111-111111111111", label: "Protocol list" },
      ],
    },
    excludedText: [],
  },
  stripe: {
    id: "provider.balance.read",
    label: "Read account balance",
    method: "GET",
    url: "https://api.stripe.com/v1/balance",
    headers: { "Stripe-Version": "2026-09-30.endive" },
    reply: {
      object: "balance",
      livemode: false,
      available: [{ amount: 100, currency: "usd" }],
      pending: [],
    },
    result: {
      label: "Stripe balance (sandbox); amounts in minor units",
      items: [{ id: "available:usd", label: "Available USD: 100 minor units" }],
    },
    excludedText: [],
  },
  linq: {
    id: "provider.phone-numbers.read",
    label: "List messaging lines",
    method: "GET",
    url: "https://api.linqapp.com/api/partner/v3/phone_numbers",
    headers: { Accept: "application/json" },
    reply: DOCUMENTED_PROBE_REPLIES.linq,
    result: {
      label: "Showing 1 of 1 returned messaging lines",
      items: [
        {
          id: "550e8400-e29b-41d4-a716-446655440000",
          label: "+12025551234 — iMessage — HEALTHY",
        },
      ],
    },
    excludedText: [
      "+12025559999",
      "private Linq upstream metadata",
      "https://docs.linqapp.com/channel/imessage/guides/phone-numbers/phone-reputation#healthy",
    ],
  },
  datadog: {
    id: "provider.monitors.read",
    label: "List monitors",
    method: "GET",
    url: "https://api.datadoghq.com/api/v1/monitor?page=0&page_size=20",
    headers: { "DD-APPLICATION-KEY": "{application_key}" },
    absentHeaders: ["authorization"],
    reply: [{ id: 12861, name: "Protocol monitor", query: "private query" }],
    result: {
      label: "Showing 1 monitor from first page",
      items: [{ id: "12861", label: "Protocol monitor" }],
    },
    excludedText: ["private query"],
  },
  algolia: {
    id: "provider.indices.read",
    label: "List indices",
    method: "GET",
    url: "https://contractapp-dsn.algolia.net/1/indexes?page=0&hitsPerPage=20",
    headers: { "X-Algolia-Application-Id": "{application_id}" },
    absentHeaders: ["authorization"],
    reply: {
      items: [
        {
          name: "products",
          entries: 194,
          privateMetadata: "private index metadata",
        },
        { name: "suppliers", entries: 83 },
      ],
      nbPages: 7,
    },
    result: {
      label: "Showing 2 indices from first page",
      items: [
        { id: "products", label: "products" },
        { id: "suppliers", label: "suppliers" },
      ],
    },
    excludedText: ["private index metadata"],
  },
  postmark: {
    id: "provider.messages.read",
    label: "List outbound messages",
    method: "GET",
    url: "https://api.postmarkapp.com/messages/outbound?count=20&offset=0&messagestream=outbound",
    headers: { Accept: "application/json" },
    absentHeaders: ["authorization", "x-postmark-account-token"],
    reply: {
      TotalCount: 194,
      Messages: [
        {
          MessageID: "0ac29aee-e1cd-480d-b08d-4f48548ff48d",
          MessageStream: "outbound",
          Subject: "Protocol welcome",
          Status: "Sent",
          To: [{ Email: "private-recipient@example.test", Name: null }],
          Recipients: ["private-recipient@example.test"],
          From: "private-sender@example.test",
          Metadata: { private: "private metadata must not render" },
        },
        {
          MessageID: "e30970cd-3901-4cc4-8b52-9e7dd57ce350",
          MessageStream: "outbound",
          Subject: "Protocol followup",
          Status: "Queued",
        },
      ],
    },
    result: {
      label: "Showing 2 of 194 messages in outbound stream",
      items: [
        {
          id: "0ac29aee-e1cd-480d-b08d-4f48548ff48d",
          label: "Protocol welcome — Sent",
        },
        {
          id: "e30970cd-3901-4cc4-8b52-9e7dd57ce350",
          label: "Protocol followup — Queued",
        },
      ],
    },
    excludedText: [
      "private-recipient@example.test",
      "private-sender@example.test",
      "private metadata must not render",
    ],
  },
};
