import type { ServerConfig } from "./config.js";

/** Deliberately enforced at the server boundary, not just an onboarding default. */
export function requireChatGPTOnly(config: ServerConfig): void {
  if (config.subagents.enabled || config.subagents.providers.some(provider => provider.enabled)) {
    throw new Error("ChatGPTForge does not support model providers or subagents. Disable subagents and all providers; reasoning stays in ChatGPT.");
  }
  if (config.host !== "127.0.0.1") {
    throw new Error("ChatGPTForge must bind to 127.0.0.1; publish only through the authenticated MCP tunnel.");
  }
  if (config.allowedHosts.includes("*")) {
    throw new Error("ChatGPTForge requires explicit allowed hosts.");
  }
}
