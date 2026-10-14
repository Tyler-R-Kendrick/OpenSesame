# Configure AI connections in Pages

Open **Settings → Integrations** and choose **BYO AI** or an AI provider.
BYO and partner pages use the same configuration form and inference controls.
Partner presets supply the API family and default endpoint; the endpoint and
model remain editable. Native catalog entries with provider-specific REST APIs
are not treated as chat-compatible merely because they are AI services.

## Choose the actual API family

| Family | Request below the API base URL | Authentication and response |
|---|---|---|
| OpenAI Chat Completions | `POST chat/completions`, with `model`, `messages` and an output-token limit. | Bearer API key; reads `choices[].message.content`, or streaming `choices[].delta.content` ending with `[DONE]`. |
| OpenAI Responses | `POST responses`, with `model`, `input` and `max_output_tokens`. | Bearer API key; reads message `output_text` blocks. Streaming uses `response.output_text.delta` and `response.completed` events. |
| Anthropic Messages | `POST messages`, with `model`, non-system `messages`, a separate `system` value and `max_tokens`. | `x-api-key`, `anthropic-version: 2023-06-01` and the direct-browser access header; streaming reads text block deltas through `message_stop`. |
| Gemini Generate Content | `POST models/{model}:generateContent`, with `contents`, `systemInstruction` and `generationConfig`. | `x-goog-api-key`; reads candidate text parts. Streaming uses `:streamGenerateContent?alt=sse` and the candidate finish event. |

BYO exposes all four families. The OpenAI partner exposes Chat Completions and
Responses; Anthropic, Gemini and other partners derive their supported family
from the existing catalog. This is text inference: the form does not claim
image, audio, tool execution or arbitrary provider REST support.

For Chat Completions, **Connection setup → Output token parameter** chooses
`max_completion_tokens` for modern OpenAI APIs or `max_tokens` for compatible
servers that require it. Partner defaults select the appropriate field without
changing the shared protocol implementation.

## Configure and verify a connection

1. Unlock the real vault that should own the API key. Guest sessions cannot
   save AI credentials.
2. Enter a connection name, family, API base URL and exact model ID. The base
   URL includes the API prefix: `https://api.example/v1`,
   `https://api.example/mounted/team/v1` or a Gemini-style `/v1beta` prefix.
   Pages appends the family-specific route beneath that mount path.
3. Choose **API key**, or explicitly choose **No authentication** for a service
   that requires none. Enter credentials only in the API key field.
4. **Test AI connection** sends a real short inference prompt with at most
   16 output tokens. It does not save configuration or credentials. The service
   can bill for that request.
5. **Save AI connection** verifies inference again, saves the credential in
   the open vault, and publishes its connection metadata only after the vault
   write succeeds. A refused or malformed response does not become a verified
   connection.
6. In **Try this model**, enter a prompt and choose **Send prompt**. The
   **Stream response** option uses the selected family's actual streaming
   protocol. A truncated stream reports failure rather than a completed answer.

The API key field is blank after saving. A blank field retains the verified key
only for unchanged endpoint, family, authentication, model and token-parameter
settings. Reenter the key when changing those settings. An older native API-key
connection can be upgraded in place by entering its model and API key again;
the new save moves credential custody into the current vault.

## Endpoint, network and CORS setup

Use HTTPS, or loopback HTTP for a local model server. Deployment policy and the
browser must also allow access to that destination, including applicable local
network permission. Endpoint URLs cannot contain embedded credentials, query
strings or fragments. Configure the final URL: redirects are refused.

Enable External connectors and permit the service through the deployment's
network policy. The API or an explicitly configured operator proxy must allow
the Pages origin through CORS. The origin includes scheme, host and port,
without the application's mount path. For example, a PWA under
`https://example.github.io/OpenSesame/` has origin `https://example.github.io`.

Permit `OPTIONS` preflights and `POST`, plus the headers used by the family:

- OpenAI families: `Content-Type`, `Authorization`.
- Anthropic: `Content-Type`, `x-api-key`, `anthropic-version` and
  `anthropic-dangerous-direct-browser-access`.
- Gemini: `Content-Type`, `x-goog-api-key`.

Return the chosen `Access-Control-Allow-Origin` and corresponding allowed
methods/headers. Streaming responses must be `text/event-stream`; a proxy
should forward SSE events without buffering the whole answer. Requests omit
browser cookies and pin credentials to the saved origin and base path. No
implicit relay or local model process is started.

A network failure can be CORS, TLS, reachability or browser permission; inspect
the browser's Network panel. HTTP 401/403 means the API key or its permissions
were refused. A successful HTTP response with the wrong family's JSON is also
a failed inference check.

## Use the connection in Features and applications

Choose the saved connection in **Settings → Features → AI → Inference**.
Options identify the connection itself, so two endpoints with the same provider
and model remain distinct. The active support inference road uses that exact
saved endpoint and credential. Remote AI support and External connectors must
both be active for the hosted support agent. Choosing a provider does not
silently download a browser model or start a server.

Application model-key delegation retains the broker's existing closed protocol,
model and budget inspection. It is available only for a verified API-key
connection whose family and normalized base URL exactly match the catalog's
canonical Chat Completions, Anthropic or Gemini contract. A custom endpoint or
Responses connection cannot back those delegated keys. Both key admission and
execution enforce that boundary; replacing a connection's target cannot lend
an older key to another endpoint. Custom and Responses connections remain
available for direct, explicit inference and the selected support model.

## Credential custody and lifecycle

Each saved key is a real standalone Token credential item in the owning vault.
The device connection ledger keeps its reference and verified digest, not a
second copy of the API key. The runtime checks the current vault, connection
revision, target binding and actual token digest before using it. Editing the
Token item requires verification and saving again before inference or
delegation resumes.

Locking, switching vaults, replacing configuration or disabling the capability
invalidates in-flight work. Later results cannot publish credentials or report
success against the old vault session. **Forget AI connection** removes the
saved connection and its exact owned credential capture; it does not revoke
the provider's key. Revoke that key with the provider when required.
