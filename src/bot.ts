import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ChannelType,
} from "discord.js";
import { setClient, getQueue, scheduleEmptyChannelLeave, cancelEmptyChannelLeave } from "./music/player";
import { YTDLP_PATH } from "./music/utils";
import { handleCommand } from "./commands/handler";
import { chatWithGemma } from "./gemma";

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

setClient(client);

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[Cathy] Discord bot logged in as ${readyClient.user.tag}`);
  console.log(`[Cathy] [YouTube] Using yt-dlp at: ${YTDLP_PATH}`);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guildId = oldState.guild.id;
  const queue = getQueue(guildId);
  if (!queue) return;

  const voiceChannel = oldState.guild.channels.cache.get(queue.voiceChannelId);
  if (!voiceChannel || !voiceChannel.isVoiceBased()) return;

  const humanCount = voiceChannel.members.filter((m) => !m.user.bot).size;
  console.log(`[Cathy] [VoiceStateUpdate] Member count updated in voice channel '${voiceChannel.name}' (${voiceChannel.id}) for guild ${guildId}. Active human users: ${humanCount}`);
  if (humanCount === 0) {
    scheduleEmptyChannelLeave(guildId);
  } else {
    cancelEmptyChannelLeave(guildId);
  }
});

client.on(Events.GuildCreate, (guild) => {
  console.log(`[Cathy] [GuildCreate] Cathy has been added to a new server:
  - Name: ${guild.name}
  - ID: ${guild.id}
  - Member Count: ${guild.memberCount}
  - Owner ID: ${guild.ownerId}
  - Description: ${guild.description || "No description"}
  - Preferred Locale: ${guild.preferredLocale}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channel.type === ChannelType.DM) {
    console.log(`[Cathy] [DM] Received DM from ${message.author.tag} (${message.author.id}) (length: ${message.content.length})`);
    try {
      await message.channel.sendTyping();
      const reply = await chatWithGemma(message.content, message.author.id);
      await message.channel.send(reply);
      console.log(`[Cathy] [DM] Sent DM response to ${message.author.tag} (${message.author.id}) (length: ${reply.length})`);
    } catch (error: any) {
      console.error(`[Cathy] [DM] Error in DM handling for user ${message.author.tag} (${message.author.id}):`, error);
      await message.channel.send("Something went wrong while generating a response.");
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const channelName = interaction.channel && 'name' in interaction.channel ? interaction.channel.name : "DM/Unknown";
  console.log(`[Cathy] [Interaction] Received command '/${interaction.commandName}' from ${interaction.user.tag} (${interaction.user.id}) in guild '${interaction.guild?.name}' (${interaction.guildId}) in channel '${channelName}' (${interaction.channelId})`);
  try {
    await handleCommand(interaction);
    console.log(`[Cathy] [Interaction] Command '/${interaction.commandName}' completed successfully for user ${interaction.user.tag}`);
  } catch (error: any) {
    console.error(`[Cathy] [Interaction] Error handling command '/${interaction.commandName}' for user ${interaction.user.tag}:`, error);
    const content = "Something went wrong while running that command.";
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, ephemeral: true });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  }
});
