import { resolve } from "node:path";

/** Everything configurable about an install comes from the environment; there is no config file. */
export interface Config {
  dataDir: string;
  dbPath: string;
  port: number;
  /** Hostnames that serve the admin (everything else is a public site). */
  adminHosts: string[];
  publicScheme: "http" | "https";
  models: {
    provider: "anthropic" | "openai" | "ollama" | "offline" | "auto";
    anthropicKey?: string;
    openaiKey?: string;
    openaiBaseUrl?: string;
    ollamaUrl?: string;
    frontierModel?: string;
    fastModel?: string;
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dataDir = resolve(env.TQ_DATA_DIR ?? "./data");
  return {
    dataDir,
    dbPath: env.TQ_DB ?? resolve(dataDir, "tidequill.db"),
    port: Number(env.TQ_PORT ?? env.PORT ?? 8080),
    adminHosts: (env.TQ_ADMIN_HOSTS ?? "localhost,127.0.0.1,[::1]").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    publicScheme: (env.TQ_PUBLIC_SCHEME as "http" | "https") ?? "https",
    models: {
      provider: (env.TQ_MODEL_PROVIDER as Config["models"]["provider"]) ?? "auto",
      anthropicKey: env.ANTHROPIC_API_KEY,
      openaiKey: env.OPENAI_API_KEY,
      openaiBaseUrl: env.OPENAI_BASE_URL,
      ollamaUrl: env.OLLAMA_URL,
      frontierModel: env.TQ_FRONTIER_MODEL,
      fastModel: env.TQ_FAST_MODEL,
    },
  };
}
