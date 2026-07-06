import { REST, Routes } from "discord.js";
import { requireEnv } from "../src/env";

const token = requireEnv("DISCORD_TOKEN");
const clientId = requireEnv("DISCORD_CLIENT_ID");
const guildId = requireEnv("DISCORD_GUILD_ID");

const rest = new REST({ version: "10" }).setToken(token);

async function main() {
  console.log(`Clearing guild-specific commands for guild ${guildId}...`);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: [],
  });
  console.log("Guild-specific commands cleared.");
}

main().catch(console.error);
