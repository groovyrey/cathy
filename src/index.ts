import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ChannelType,
  EmbedBuilder,
  Colors,
  type ChatInputCommandInteraction,
} from "discord.js";

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
  getVoiceConnection,
  type VoiceConnection,
  type AudioPlayer,
} from "@discordjs/voice";
import { spawn } from "child_process";
import ffmpegStatic from "ffmpeg-static";
import { Readable } from "stream";

import { requireEnv } from "./env";
import { chatWithGemma } from "./gemma";


/** Resolve the path to yt-dlp (prefers local install, falls back to PATH) */
function getYtDlpPath(): string {
  const fs = require("fs");
  const candidates = [
    "/home/azureuser/.local/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
    "yt-dlp",
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* */ }
  }
  return "yt-dlp";
}


const FFMPEG_PATH: string = ffmpegStatic as string;

// ─── Constants ────────────────────────────────────────────────────────────────

/** yt-dlp binary path (resolved once at startup) */
const YTDLP_PATH: string = getYtDlpPath();

/** Auto-leave voice after this many ms of the channel being empty */
const EMPTY_CHANNEL_TIMEOUT_MS = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface QueueTrack {
  title: string;
  /** YouTube watch URL — stable, used to re-fetch a fresh stream at play time */
  permalinkUrl: string;
  durationSec: number;
  requestedBy: string;
  requestedById: string;
  /** YouTube video thumbnail URL */
  thumbnailUrl?: string;
}

interface GuildQueue {
  tracks: QueueTrack[];
  player: AudioPlayer;
  connection: VoiceConnection;
  voiceChannelId: string;
  textChannelId: string;
  /** Timestamp when the current track started playing */
  startedAt: number;
  emptyChannelTimer: ReturnType<typeof setTimeout> | null;
}

// ─── State ────────────────────────────────────────────────────────────────────

const queues = new Map<string, GuildQueue>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "Live";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

async function getYtMetadata(query: string): Promise<QueueTrack | null> {
  const isUrl = query.startsWith("http");
  const searchPrefix = isUrl ? "" : "ytsearch1:";
  
  const args = [
    "--dump-json",
    "--no-playlist",
    "--quiet",
    "--js-runtimes", "node",
    "--remote-components", "ejs:github",
  ];

  if (process.env.YOUTUBE_COOKIES_PATH) {
    args.push("--cookies", process.env.YOUTUBE_COOKIES_PATH);
  }

  args.push(`${searchPrefix}${query}`);

  return new Promise((resolve) => {
    const proc = spawn(YTDLP_PATH, args);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data; });
    proc.stderr.on("data", (data) => { stderr += data; });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(`[Cathy] [yt-dlp] Metadata error (code ${code}): ${stderr}`);
        return resolve(null);
      }

      try {
        const data = JSON.parse(stdout);
        // yt-dlp returns an array for search queries, but an object for direct URLs
        const video = Array.isArray(data) ? data[0] : data;

        if (!video) return resolve(null);

        resolve({
          title: video.title ?? "Unknown Title",
          permalinkUrl: video.webpage_url ?? query,
          durationSec: video.duration ?? 0,
          requestedBy: "", // Filled by caller
          requestedById: "", // Filled by caller
          thumbnailUrl: video.thumbnail,
        });
      } catch (e) {
        console.error(`[Cathy] [yt-dlp] JSON parse error:`, e);
        resolve(null);
      }
    });
  });
}

function nowPlayingEmbed(track: QueueTrack, queueLength: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle("🎧 Cathy's Current Jam")
    .setDescription(`**[${track.title}](${track.permalinkUrl})**`)
    .addFields(
      { name: "Duration", value: formatDuration(track.durationSec), inline: true },
      { name: "Requested by", value: `<@${track.requestedById}>`, inline: true },
      { name: "Up next", value: queueLength > 1 ? `${queueLength - 1} more songs coming up! ✨` : "That's it for now! Queue's empty! 🌈", inline: true },
    )
    .setThumbnail(track.thumbnailUrl ?? null)
    .setFooter({ text: "YouTube • Jamming with Cathy 🎵" })
    .setTimestamp();
}

function addedEmbed(track: QueueTrack, position: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("✅ Added to the list!")
    .setDescription(`**[${track.title}](${track.permalinkUrl})**`)
    .addFields(
      { name: "Duration", value: formatDuration(track.durationSec), inline: true },
      { name: "Requested by", value: `<@${track.requestedById}>`, inline: true },
      { name: "Position", value: `Coming up at #${position}! 🎶`, inline: true },
    )
    .setFooter({ text: "YouTube • Cathy's Music Box 📦" });
}

// ─── Queue / Playback ─────────────────────────────────────────────────────────


async function playNext(guildId: string): Promise<void> {
  const queue = queues.get(guildId);
  if (!queue) return;

  if (queue.tracks.length === 0) {
    console.log(`[Cathy] [Queue] Queue is empty for guild ${guildId}, initiating teardown.`);
    teardown(guildId);
    return;
  }

  const track = queue.tracks[0];
  queue.startedAt = Date.now();

  try {
    // Give the connection a moment to begin its handshake before streaming.
    // We do NOT await entersState(Ready) because on some server setups the
    // connection reaches Ready only after the player starts sending packets.
    const connStatus = queue.connection.state.status;
    console.log(`[Cathy] [Player] Connection state: ${connStatus} in guild ${guildId}`);
    if (connStatus === VoiceConnectionStatus.Destroyed) {
      console.error(`[Cathy] [Player] Connection destroyed for guild ${guildId} — aborting playback.`);
      teardown(guildId);
      return;
    }

    // Stream via: yt-dlp stdout → ffmpeg stdin → OGG Opus stdout
    // This avoids the segfault that occurs when ffmpeg-static reads HTTPS URLs directly.
    console.log(`[Cathy] [Player] Spawning yt-dlp for "${track.title}" in guild ${guildId}`);
    const ytdlpArgs = [
      "--format", "bestaudio[ext=webm]/bestaudio/best",
      "--no-playlist",
      "-o", "-",                // output to stdout
      "--quiet",               // suppress progress output
      "--js-runtimes", "node",
      "--remote-components", "ejs:github",
    ];

    if (process.env.YOUTUBE_COOKIES_PATH) {
      ytdlpArgs.push("--cookies", process.env.YOUTUBE_COOKIES_PATH);
    }

    ytdlpArgs.push(track.permalinkUrl);

    const ytdlpProc = spawn(YTDLP_PATH, ytdlpArgs, { stdio: ["ignore", "pipe", "ignore"] });

    const ffmpegProc = spawn(FFMPEG_PATH, [
      "-i",               "pipe:0",
      "-analyzeduration", "0",
      "-loglevel",        "error",
      "-vn",
      "-ac",              "2",
      "-ar",              "48000",
      "-c:a",             "libopus",
      "-b:a",             "128k",
      "-f",               "ogg",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    // Suppress EPIPE — normal when player stops before source finishes
    ffmpegProc.stdin.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "EPIPE") console.error("[ffmpeg stdin]", e.message);
    });
    ffmpegProc.stderr.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.error("[ffmpeg]", msg);
    });

    // Pipe yt-dlp's audio output into ffmpeg's stdin
    ytdlpProc.stdout.pipe(ffmpegProc.stdin, { end: true });

    const oggStream = ffmpegProc.stdout as unknown as Readable;

    const resource = createAudioResource(oggStream, {
      inputType: StreamType.OggOpus,
      inlineVolume: false,
    });

    const cleanupProcs = () => {
      try { ffmpegProc.kill("SIGKILL"); } catch { /* already dead */ }
      try { ytdlpProc.kill("SIGKILL"); } catch { /* already dead */ }
    };

    // Subscribe BEFORE playing so voice packets are routed correctly
    queue.connection.subscribe(queue.player);

    queue.player.removeAllListeners(AudioPlayerStatus.Idle);
    queue.player.removeAllListeners("error");

    queue.player.once(AudioPlayerStatus.Idle, () => {
      console.log(`[Cathy] [Player] Finished playing track: "${track.title}" in guild ${guildId}`);
      cleanupProcs();
      queue.tracks.shift();
      playNext(guildId);
    });

    queue.player.once("error" as any, (err: Error) => {
      console.error(`[Cathy] [Player] Error playing "${track.title}" in guild ${guildId}:`, err.message);
      cleanupProcs();
      queue.tracks.shift();
      playNext(guildId);
    });

    queue.player.play(resource);
    console.log(`[Cathy] [Player] Now playing: "${track.title}" (Requested by: ${track.requestedBy} / ${track.requestedById}) in guild ${guildId}`);
  } catch (err) {
    console.error(`[Cathy] [Player] Failed to play "${track.title}" in guild ${guildId}:`, err);
    queue.tracks.shift();
    playNext(guildId);
  }
}

function teardown(guildId: string): void {
  const queue = queues.get(guildId);
  if (!queue) return;
  if (queue.emptyChannelTimer) clearTimeout(queue.emptyChannelTimer);
  queue.player.removeAllListeners();
  queue.player.stop(true);
  queue.connection.destroy();
  queues.delete(guildId);
  console.log(`[Cathy] [Queue] Cleaned up voice queue and connection for guild ${guildId}`);
}

function scheduleEmptyChannelLeave(guildId: string): void {
  const queue = queues.get(guildId);
  if (!queue) return;
  if (queue.emptyChannelTimer) clearTimeout(queue.emptyChannelTimer);
  console.log(`[Cathy] [Queue] Voice channel empty in guild ${guildId}. Scheduling auto-leave in ${EMPTY_CHANNEL_TIMEOUT_MS / 1000}s`);
  queue.emptyChannelTimer = setTimeout(() => {
    console.log(`[Cathy] [Queue] Voice channel remained empty in guild ${guildId} — auto-leaving channel.`);
    teardown(guildId);
  }, EMPTY_CHANNEL_TIMEOUT_MS);
}

function cancelEmptyChannelLeave(guildId: string): void {
  const queue = queues.get(guildId);
  if (!queue || !queue.emptyChannelTimer) return;
  console.log(`[Cathy] [Queue] Member joined voice channel in guild ${guildId}. Canceled scheduled auto-leave.`);
  clearTimeout(queue.emptyChannelTimer);
  queue.emptyChannelTimer = null;
}

// ─── Discord Client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[Cathy] Discord bot logged in as ${readyClient.user.tag}`);
  console.log(`[Cathy] [YouTube] Using yt-dlp at: ${YTDLP_PATH}`);
});

// Auto-leave when bot is alone in a voice channel
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guildId = oldState.guild.id;
  const queue = queues.get(guildId);
  if (!queue) return;

  const voiceChannel = oldState.guild.channels.cache.get(queue.voiceChannelId);
  if (!voiceChannel || !voiceChannel.isVoiceBased()) return;

  // Count non-bot members
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
    console.log(`[Cathy] [DM] Received DM from ${message.author.tag} (${message.author.id}): "${message.content}"`);
    try {
      await message.channel.sendTyping();
      const reply = await chatWithGemma(message.content);
      await message.channel.send(reply);
      console.log(`[Cathy] [DM] Sent DM response to ${message.author.tag} (${message.author.id}): "${reply}"`);
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

// ─── Command Handler ──────────────────────────────────────────────────────────

async function handleCommand(interaction: ChatInputCommandInteraction) {
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
    console.log(`[Cathy] [Command] /talk triggered by ${interaction.user.tag} with message: "${query}"`);
    await interaction.deferReply();
    try {
      const reply = await chatWithGemma(query);
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

      let queue = queues.get(guildId);

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
        };
        queues.set(guildId, queue);

        await interaction.editReply({ embeds: [nowPlayingEmbed(newTrack, 1)] });
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

  // ─── /nowplaying ──────────────────────────────────────────────────────────
  if (interaction.commandName === "nowplaying") {
    if (!guildId) { await interaction.reply("❌ Server-only command."); return; }
    const queue = queues.get(guildId);

    if (!queue || queue.tracks.length === 0) {
      console.log(`[Cathy] [Command] /nowplaying requested but queue is empty in guild ${guildId}`);
      await interaction.reply("📭 Nothing is playing right now.");
      return;
    }

    const track = queue.tracks[0];
    const elapsed = Math.floor((Date.now() - queue.startedAt) / 1000);
    const total = track.durationSec;

    console.log(`[Cathy] [Command] /nowplaying retrieved for track "${track.title}" in guild ${guildId}`);

    // Build a simple text progress bar
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
    const queue = queues.get(guildId);

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
    const queue = queues.get(guildId);

    if (!queue || queue.tracks.length === 0) {
      console.log(`[Cathy] [Command] /skip failed: no track playing in guild ${guildId}`);
      await interaction.reply("❌ Nothing is playing to skip, silly!");
      return;
    }

    const skipped = queue.tracks[0];
    const next = queue.tracks[1];
    console.log(`[Cathy] [Command] /skip: User ${interaction.user.tag} skipped track "${skipped.title}" in guild ${guildId}`);
    queue.player.stop(true);   // triggers Idle → playNext()

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
    const queue = queues.get(guildId);

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
    const queue = queues.get(guildId);

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
    const queue = queues.get(guildId);

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
    const queue = queues.get(guildId);

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

void client.login(requireEnv("DISCORD_TOKEN"));
