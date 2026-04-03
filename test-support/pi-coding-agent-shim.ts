export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? "";
}

export type ExtensionAPI = any;
export type ExtensionContext = any;
