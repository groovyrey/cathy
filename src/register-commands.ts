import { REST, Routes } from "discord.js";

import { commandPayloads } from "./commands";
import { requireEnv } from "./env";

const token = requireEnv("DISCORD_TOKEN");
const clientId = requireEnv("DISCORD_CLIENT_ID");

const rest = new REST({ version: "10" }).setToken(token);

async function main() {
  console.log(`Registering ${commandPayloads.length} Discord slash commands globally.`);

  await rest.put(Routes.applicationCommands(clientId), {
    body: commandPayloads,
  });

  console.log("Discord slash commands registered globally.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

