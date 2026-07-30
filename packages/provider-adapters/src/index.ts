import type {
  ProviderAdapter,
  ProviderCredentials,
} from "@scopeguard/agent-runtime";

import { AnthropicCompatibleAdapter } from "./anthropic.js";
import { OpenAICompatibleAdapter } from "./openai.js";
import type { FetchImplementation } from "./shared.js";

export { AnthropicCompatibleAdapter } from "./anthropic.js";
export { OpenAICompatibleAdapter } from "./openai.js";
export {
  ProviderRequestError,
  appendEndpoint,
} from "./shared.js";
export {
  parseServerSentEvents,
  type ServerSentEvent,
} from "./sse.js";

export function createProviderAdapter(
  credentials: Pick<ProviderCredentials, "protocol">,
  fetchImplementation: FetchImplementation = fetch,
): ProviderAdapter {
  switch (credentials.protocol) {
    case "openai-compatible":
      return new OpenAICompatibleAdapter(fetchImplementation);
    case "anthropic-compatible":
      return new AnthropicCompatibleAdapter(fetchImplementation);
  }
}
