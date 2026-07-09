import { client } from "./bot";
import { requireEnv } from "./env";

void client.login(requireEnv("DISCORD_TOKEN"));
