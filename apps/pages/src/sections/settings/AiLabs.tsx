/**
 * Settings › Integrations › AI — the labs a person may bring a key for.
 *
 * The catalog decides which rows a browser can actually configure. The rest
 * of the main labs still belong in the list: a person looking for their
 * provider should find its name here, even where this build has no connector
 * page for it yet. A supported row links to its page once Connections routes
 * it; an unsupported row is the same tile without a link.
 */

import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { connectorPath } from "@opensesame/app-core/sections/connections/shared.js";
import { useConnectorRoads } from "../../bindings/connector-roads.js";
import { ConnectorMark } from "../connections/ConnectorMark.js";
import { FeatureBindingTile } from "./FeatureBindingTile.js";

/** The labs the AI section lists, in the order a person scans them. */
export const AI_LABS = [
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "cohere", name: "Cohere" },
  { id: "mistral", name: "Mistral" },
  { id: "groq", name: "Groq" },
  { id: "perplexity", name: "Perplexity" },
  { id: "together", name: "Together AI" },
  { id: "huggingface", name: "Hugging Face" },
  { id: "elevenlabs", name: "ElevenLabs" },
  { id: "gemini", name: "Google Gemini" },
  { id: "fireworks", name: "Fireworks AI" },
  { id: "azure-openai", name: "Azure OpenAI" },
  { id: "aws-bedrock", name: "Amazon Bedrock" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "xai", name: "xAI" },
  { id: "meta", name: "Meta" },
  { id: "zai", name: "Z.ai" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "nvidia", name: "NVIDIA" },
  { id: "minimax", name: "MiniMax" },
  { id: "moonshotai", name: "Moonshot AI" },
  { id: "alibaba", name: "Alibaba" },
  { id: "vercel-ai-gateway", name: "Vercel" },
  { id: "xiaomi", name: "Xiaomi" },
  { id: "ollama", name: "Ollama" },
  { id: "google-vertex", name: "Google Vertex AI" },
  { id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway" },
  { id: "higgsfield", name: "Higgsfield" },
  { id: "fal-ai", name: "fal.ai" },
] as const;

function LabTile({ id, name }: { id: string; name: string }) {
  return (
    <li className="conn-tile">
      <div className="conn-tile__row">
        <span className="conn-tile__face">
          <ConnectorMark providerId={id} displayName={name} size={32} />
          <span className="conn-tile__copy">
            <span className="conn-tile__name">{name}</span>
          </span>
        </span>
      </div>
    </li>
  );
}

export function AiLabs() {
  const roads = useConnectorRoads();
  const providers = new Map(
    getBundledProviders().map((provider) => [provider.id, provider]),
  );
  return (
    <ul className="conn-grid" id="ai_model_provider" aria-label="AI providers">
      {AI_LABS.map((lab) => {
        const provider = providers.get(lab.id);
        const road = provider ? roads.tile(provider) : null;
        if (provider && road === "page") {
          return (
            <FeatureBindingTile
              key={lab.id}
              provider={{ ...provider, displayName: lab.name }}
              href={connectorPath(
                provider.id,
                undefined,
                "/settings/connections",
              )}
              target={null}
            />
          );
        }
        return <LabTile key={lab.id} id={lab.id} name={lab.name} />;
      })}
    </ul>
  );
}
