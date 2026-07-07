import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

type EnvKey = "DISCORD_TOKEN" | "DISCORD_CLIENT_ID" | "DISCORD_GUILD_ID" | "GEMINI_API_KEY" | "YOUTUBE_COOKIES_PATH" | "TURSO_AUTH_TOKEN" | "TURSO_DATABASE_URL";

export function requireEnv(key: EnvKey): string {
  const value = process.env[key];

  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}
