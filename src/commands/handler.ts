import {
  joinVoiceChannel,
  createAudioPlayer,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";
import {
  EmbedBuilder,
  Colors,
  type ChatInputCommandInteraction,
} from "discord.js";
import { chatWithGemma } from "../gemma";
import { db } from "../db";
import { getYtMetadata, formatDuration, nowPlayingEmbed, addedEmbed } from "../music/utils";
import { playNext, teardown, getQueue, setQueue } from "../music/player";
import type { QueueTrack } from "../music/types";

export async function handleCommand(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId;

  // /ping
  if (interaction.commandName === "ping") {
    console.log(`[Cathy] [Command] /ping triggered by ${interaction.user.tag}`);
    await interaction.reply("🏓 Pong!");
    return;
  }

  // /echo
  if (interaction.commandName === "echo") {
    const message = interaction.options.getString("message", true);
    console.log(`[Cathy] [Command] /echo triggered by ${interaction.user.tag} with message: "${message}"`);
    await interaction.reply(message);
    return;
  }

  // /talk
  if (interaction.commandName === "talk") {
    const query = interaction.options.getString("message", true);
    console.log(`[Cathy] [Command] /talk triggered by ${interaction.user.tag} (length: ${query.length})`);
    await interaction.deferReply();
    try {
      const reply = await chatWithGemma(query, interaction.user.id);
      await interaction.editReply(reply);
      console.log(`[Cathy] [Command] /talk successfully replied to ${interaction.user.tag}`);
    } catch (error: any) {
      console.error(`[Cathy] [Command] /talk failed for user ${interaction.user.tag}:`, error);
      await interaction.editReply("Something went wrong while generating response.");
    }
    return;
  }

  // ─── /play ────────────────────────────────────────────────────────────────
  if (interaction.commandName === "play") {
    const song = interaction.options.getString("song", true);
    console.log(`[Cathy] [Command] /play triggered by ${interaction.user.tag} with query: "${song}"`);
    await interaction.deferReply();

    const member = interaction.member;
    if (!member || !("voice" in member) || !member.voice.channel) {
      console.log(`[Cathy] [Command] /play cancelled: user ${interaction.user.tag} is not in a voice channel`);
      await interaction.editReply("❌ You need to be in a voice channel to use `/play`!");
      return;
    }
    if (!guildId) {
      console.log(`[Cathy] [Command] /play cancelled: command must be run in a server`);
      await interaction.editReply("❌ Server-only command.");
      return;
    }

    const voiceChannel = member.voice.channel;

    try {
      const metadata = await getYtMetadata(song);

      if (!metadata) {
        console.log(`[Cathy] [Command] /play: No YouTube results found for query: "${song}"`);
        await interaction.editReply(`❌ No YouTube results found for \`${song}\`.`);
        return;
      }

      const newTrack: QueueTrack = {
        ...metadata,
        requestedBy: interaction.user.username,
        requestedById: interaction.user.id,
      };

      console.log(`[Cathy] [Command] /play: Selected track "${newTrack.title}" (${newTrack.permalinkUrl})`);

      let queue = getQueue(guildId);

      if (!queue) {
        // ── First track: join channel & boot the queue ──
        console.log(`[Cathy] [Queue] Joining voice channel '${voiceChannel.name}' (${voiceChannel.id}) in guild ${guildId}`);
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId,
          adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        });

        // Handle unexpected disconnects — try to reconnect, otherwise tear down
        connection.on(VoiceConnectionStatus.Disconnected, async () => {
          console.log(`[Cathy] [Player] Disconnected from voice in guild ${guildId}. Attempting reconnection...`);
          try {
            await Promise.race([
              entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
              entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
            console.log(`[Cathy] [Player] Reconnected successfully in guild ${guildId}`);
          } catch {
            console.warn(`[Cathy] [Player] Reconnection failed in guild ${guildId}, tearing down.`);
            teardown(guildId);
          }
        });

        const player = createAudioPlayer();

        queue = {
          tracks: [newTrack],
          player,
          connection,
          voiceChannelId: voiceChannel.id,
          textChannelId: interaction.channelId,
          startedAt: Date.now(),
          emptyChannelTimer: null,
          playing: false,
        };
        setQueue(guildId, queue);

        await interaction.editReply({ embeds: [nowPlayingEmbed(newTrack, 0)] });
        console.log(`[Cathy] [Queue] Started playNext for guild ${guildId}`);
        playNext(guildId);
      } else {
        // ── Duplicate guard ──
        const alreadyQueued = queue.tracks.find((t) => t.permalinkUrl === newTrack.permalinkUrl);
        if (alreadyQueued) {
          console.log(`[Cathy] [Queue] Track "${newTrack.title}" already exists in queue for guild ${guildId}`);
          await interaction.editReply(`⚠️ **${newTrack.title}** is already in the queue.`);
          return;
        }

        queue.tracks.push(newTrack);
        console.log(`[Cathy] [Queue] Track "${newTrack.title}" added to queue (position: ${queue.tracks.length}) in guild ${guildId}`);
        await interaction.editReply({ embeds: [addedEmbed(newTrack, queue.tracks.length)] });
      }
    } catch (error) {
      console.error(`[Cathy] [Command] /play failed for query "${song}":`, error);
      await interaction.editReply("❌ An error occurred while trying to play the music. Please try again.");
    }
    return;
  }

  // ─── /topmusic ──────────────────────────────────────────────────────────
  if (interaction.commandName === "topmusic") {
    console.log(`[Cathy] [Command] /topmusic triggered by ${interaction.user.tag}`);
    await interaction.deferReply();
    try {
      const result = await db.execute("SELECT title, permalinkUrl, thumbnailUrl, playCount FROM songs ORDER BY playCount DESC LIMIT 10");
      const topSongs = result.rows as any[];

      if (topSongs.length === 0) {
        await interaction.editReply("📭 No songs have been played yet! Be the first to jam! 🎵");
        return;
      }

      const lines = topSongs.map((song, i) =>
        `**${i + 1}.** [${song.title}](${song.permalinkUrl}) — 🎧 \`${song.playCount}\` plays`
      ).join("\n");

      const embed = new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle("🏆 Cathy's All-Time Top Jams")
        .setDescription(lines)
        .setFooter({ text: "The most played tracks across all servers! 🌟" })
        .setTimestamp();

      if (topSongs[0].thumbnailUrl) {
        embed.setThumbnail(topSongs[0].thumbnailUrl);
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error(`[Cathy] [Command] /topmusic failed:`, error);
      await interaction.editReply("❌ An error occurred while fetching the top songs.");
    }
    return;
  }

  // ─── /nowplaying ──────────────────────────────────────────────────────────
  if (interaction.commandName === "nowplaying") {
    if (!guildId) { await interaction.reply("❌ Server-only command."); return; }
    const queue = getQueue(guildId);

    if (!queue || queue.tracks.length === 0) {
      console.log(`[Cathy] [Command] /nowplaying requested but queue is empty in guild ${guildId}`);
      await interaction.reply("📭 Nothing is playing right now.");
      return;
    }

    const track = queue.tracks[0];
    const elapsed = Math.floor((Date.now() - queue.startedAt) / 1000);
    const total = track.durationSec;

    console.log(`[Cathy] [Command] /nowplaying retrieved for track "${track.title}" in guild ${guildId}`);

    const BAR_LENGTH = 20;
    const filled = total > 0 ? Math.round((elapsed / total) * BAR_LENGTH) : 0;
    const bar = "█".repeat(Math.min(filled, BAR_LENGTH)) + "░".repeat(Math.max(0, BAR_LENGTH - filled));
    const progress = `\`${formatDuration(elapsed)}\` ${bar} \`${formatDuration(total)}\``;

    const embed = nowPlayingEmbed(track, queue.tracks.length)
      .setDescription(`**[${track.title}](${track.permalinkUrl})**\n\n${progress}`);

    await interaction.reply({ embeds: [embed] });
    return;
  }

  // ─── /queue ───────────────────────────────────────────────────────────────
  if (interaction.commandName === "queue") {
    if (!guildId) { await interaction.reply("❌ Server-only command."); return; }
    const queue = getQueue(guildId);

    if (!queue || queue.tracks.length === 0) {
      console.log(`[Cathy] [Command] /queue requested but queue is empty in guild ${guildId}`);
      await interaction.reply("📭 The queue is currently empty.");
      return;
    }

    console.log(`[Cathy] [Command] /queue retrieved with ${queue.tracks.length} tracks in guild ${guildId}`);

    const totalSec = queue.tracks.reduce((acc, t) => acc + t.durationSec, 0);

    const lines = queue.tracks.slice(0, 15).map((t, i) =>
      i === 0
        ? `▶️ **${t.title}** \`[${formatDuration(t.durationSec)}]\` — <@${t.requestedById}>`
        : `**${i}.** ${t.title} \`[${formatDuration(t.durationSec)}]\` — <@${t.requestedById}>`
    );

    if (queue.tracks.length > 15) lines.push(`*...and ${queue.tracks.length - 15} more tracks*`);

    const embed = new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setTitle(`🎵 Cathy's Music List — ${queue.tracks.length} song${queue.tracks.length !== 1 ? "s" : ""}`)
      .setDescription(lines.join("\n"))
      .setFooter({ text: `Total duration: ${formatDuration(totalSec)} • Jamming with Cathy 🎵` });

    await interaction.reply({ embeds: [embed] });
    return;
  }

  // ─── /skip ────────────────────────────────────────────────────────────────
  if (interaction.commandName === "skip") {
    if (!guildId) { await interaction.reply("❌ Server-only command."); return; }
    const queue = getQueue(guildId);

    if (!queue || queue.tracks.length === 0) {
      console.log(`[Cathy] [Command] /skip failed: no track playing in guild ${guildId}`);
      await interaction.reply("❌ Nothing is playing to skip, silly!");
      return;
    }

    const skipped = queue.tracks[0];
    const next = queue.tracks[1];
    console.log(`[Cathy] [Command] /skip: User ${interaction.user.tag} skipped track "${skipped.title}" in guild ${guildId}`);
    queue.player.stop(true);

    const embed = new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle("⏭️ Next song, please!")
      .setDescription(`**${skipped.title}** was skipped!`)
      .addFields({ name: "Up next", value: next ? `**${next.title}**` : "Nothing — queue is now empty! 🌈", inline: false });

    await interaction.reply({ embeds: [embed] });
    return;
  }

  // ─── /remove ──────────────────────────────────────────────────────────────
  if (interaction.commandName === "remove") {
    if (!guildId) { await interaction.reply("❌ Server-only command."); return; }
    const queue = getQueue(guildId);

    if (!queue || queue.tracks.length === 0) {
      console.log(`[Cathy] [Command] /remove failed: queue is empty in guild ${guildId}`);
      await interaction.reply("❌ The queue is empty.");
      return;
    }

    const pos = interaction.options.getInteger("position", true);
    if (pos < 1 || pos >= queue.tracks.length) {
      console.log(`[Cathy] [Command] /remove failed: invalid position ${pos} for queue length ${queue.tracks.length} in guild ${guildId}`);
      await interaction.reply(`❌ Invalid position. Choose between 1 and ${queue.tracks.length - 1} (can't remove the currently playing track).`);
      return;
    }

    const [removed] = queue.tracks.splice(pos, 1);
    console.log(`[Cathy] [Command] /remove: User ${interaction.user.tag} removed track "${removed.title}" from position ${pos} in guild ${guildId}`);
    await interaction.reply(`🗑️ Removed **${removed.title}** from the queue.`);
    return;
  }

  // ─── /stop ────────────────────────────────────────────────────────────────
  if (interaction.commandName === "stop") {
    await interaction.deferReply();
    if (!guildId) { await interaction.editReply("❌ Server-only command."); return; }
    const queue = getQueue(guildId);

    if (!queue) {
      console.log(`[Cathy] [Command] /stop failed: not in voice channel for guild ${guildId}`);
      await interaction.editReply("❌ Not currently in a voice channel.");
      return;
    }

    console.log(`[Cathy] [Command] /stop: User ${interaction.user.tag} stopped playback and cleared queue for guild ${guildId}`);
    teardown(guildId);
    await interaction.editReply("⏹️ Stopped playback and cleared the queue.");
    return;
  }

  // ─── /pause ───────────────────────────────────────────────────────────────
  if (interaction.commandName === "pause") {
    if (!guildId) { await interaction.reply("❌ Server-only command."); return; }
    const queue = getQueue(guildId);

    if (!queue) {
      console.log(`[Cathy] [Command] /pause failed: nothing playing in guild ${guildId}`);
      await interaction.reply("❌ Nothing is playing.");
      return;
    }
    if (queue.player.state.status === AudioPlayerStatus.Paused) {
      console.log(`[Cathy] [Command] /pause failed: already paused in guild ${guildId}`);
      await interaction.reply("⚠️ Already paused. Use `/resume` to continue.");
      return;
    }

    console.log(`[Cathy] [Command] /pause: User ${interaction.user.tag} paused playback in guild ${guildId}`);
    queue.player.pause();
    await interaction.reply("⏸️ Paused.");
    return;
  }

  // ─── /resume ──────────────────────────────────────────────────────────────
  if (interaction.commandName === "resume") {
    if (!guildId) { await interaction.reply("❌ Server-only command."); return; }
    const queue = getQueue(guildId);

    if (!queue) {
      console.log(`[Cathy] [Command] /resume failed: no active queue in guild ${guildId}`);
      await interaction.reply("❌ Nothing is paused.");
      return;
    }
    if (queue.player.state.status !== AudioPlayerStatus.Paused) {
      console.log(`[Cathy] [Command] /resume failed: music is not paused in guild ${guildId}`);
      await interaction.reply("⚠️ Music is not paused.");
      return;
    }

    console.log(`[Cathy] [Command] /resume: User ${interaction.user.tag} resumed playback in guild ${guildId}`);
    queue.player.unpause();
    await interaction.reply("▶️ Resumed.");
    return;
  }

  // ─── /about ───────────────────────────────────────────────────────────────
  if (interaction.commandName === "about") {
    console.log(`[Cathy] [Command] /about triggered by ${interaction.user.tag}`);
    const embed = new EmbedBuilder()
      .setColor(0xe8837a)
      .setTitle("🌧️ About Cathy")
      .setDescription(
        "Hi! I'm **Catherine Joyce \"Cath\" Portillo** — but everyone calls me **Cathy**!\n" +
        "I'm a cheerful, baking-obsessed, rain-loving, sardine-hating 15-year-old from the game *Until Then*. " +
        "Now living my best life on Discord! 🎮🍪"
      )
      .addFields(
        {
          name: "🛠️ Created by",
          value: "**Reymart Centeno**\n📧 reymartcenteno03@gmail.com",
          inline: false,
        },
        {
          name: "🎵 Music",
          value: "Use `/play <song>` to play music from YouTube!",
          inline: true,
        },
        {
          name: "💬 Chat",
          value: "Send me a DM and I'll talk to you!",
          inline: true,
        },
      )
      .setFooter({ text: "Until then! 🌧️" })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    return;
  }

  await interaction.reply({ content: "Unknown command.", ephemeral: true });
}
