/**
 * The AI labs Settings › Integrations lists, in the order a person scans
 * them. Connections uses this same set so the browse catalog cannot drift
 * into a longer, provider-only list.
 */
export const INTEGRATION_AI_LABS = [
  { id: "byo-ai", name: "BYO AI" },
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "cohere", name: "Cohere" },
  { id: "mistral", name: "Mistral" },
  { id: "groq", name: "Groq" },
  { id: "perplexity", name: "Perplexity" },
  { id: "together", name: "Together AI" },
  { id: "replicate", name: "Replicate" },
  { id: "huggingface", name: "Hugging Face" },
  { id: "elevenlabs", name: "ElevenLabs" },
  { id: "stability", name: "Stability AI" },
  { id: "deepgram", name: "Deepgram" },
  { id: "assemblyai", name: "AssemblyAI" },
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

export type IntegrationAiLab = (typeof INTEGRATION_AI_LABS)[number];
