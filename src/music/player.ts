import {
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
} from "@discordjs/voice";
import { spawn } from "child_process";
import { Readable } from "stream";
import type { Client } from "discord.js";
import { db } from "../db";
import { YTDLP_PATH, FFMPEG_PATH, nowPlayingEmbed } from "./utils";
import type { GuildQueue } from "./types";

const EMPTY_CHANNEL_TIMEOUT_MS = 30_000;

const queues = new Map<string, GuildQueue>();

let client: Client;

export function setClient(c: Client) {
  client = c;
}

export function getQueue(guildId: string): GuildQueue | undefined {
  return queues.get(guildId);
}

export function setQueue(guildId: string, queue: GuildQueue) {
  queues.set(guildId, queue);
}

export function deleteQueue(guildId: string) {
  queues.delete(guildId);
}

export async function playNext(guildId: string): Promise<void> {
  const queue = queues.get(guildId);
  if (!queue) return;

  if (queue.playing) {
    console.log(`[Cathy] [Player] Already playing in guild ${guildId}, ignoring playNext.`);
    return;
  }

  if (queue.tracks.length === 0) {
    console.log(`[Cathy] [Queue] Queue is empty for guild ${guildId}, initiating teardown.`);
    teardown(guildId);
    return;
  }

  const track = queue.tracks[0];
  queue.startedAt = Date.now();
  queue.playing = true;

  try {
    const connStatus = queue.connection.state.status;
    console.log(`[Cathy] [Player] Connection state: ${connStatus} in guild ${guildId}`);
    if (connStatus === VoiceConnectionStatus.Destroyed) {
      console.error(`[Cathy] [Player] Connection destroyed for guild ${guildId} — aborting playback.`);
      queue.playing = false;
      teardown(guildId);
      return;
    }

    queue.player.stop(true);
    queue.player.removeAllListeners(AudioPlayerStatus.Idle);
    queue.player.removeAllListeners("error");

    console.log(`[Cathy] [Player] Spawning yt-dlp for "${track.title}" in guild ${guildId}`);
    const ytdlpArgs = [
      "--format", "bestaudio[ext=webm]/bestaudio/best",
      "--no-playlist",
      "-o", "-",
      "--quiet",
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

    ffmpegProc.stdin.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "EPIPE") console.error("[ffmpeg stdin]", e.message);
    });
    ffmpegProc.stderr.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.error("[ffmpeg]", msg);
    });

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

    queue.connection.subscribe(queue.player);

    queue.player.once(AudioPlayerStatus.Idle, () => {
      console.log(`[Cathy] [Player] Finished playing track: "${track.title}" in guild ${guildId}`);
      cleanupProcs();
      queue.playing = false;
      queue.tracks.shift();
      playNext(guildId);
    });

    queue.player.once("error" as any, (err: Error) => {
      console.error(`[Cathy] [Player] Error playing "${track.title}" in guild ${guildId}:`, err.message);
      cleanupProcs();
      queue.playing = false;
      queue.tracks.shift();
      playNext(guildId);
    });

    queue.player.play(resource);

    try {
      await db.execute({
        sql: "INSERT INTO songs (permalinkUrl, title, thumbnailUrl, playCount) VALUES (?, ?, ?, 1) ON CONFLICT(permalinkUrl) DO UPDATE SET playCount = playCount + 1",
        args: [track.permalinkUrl, track.title, track.thumbnailUrl ?? null],
      });
    } catch (err) {
      console.error(`[Cathy] [DB] Failed to update play count for "${track.title}":`, err);
    }

    try {
      const textChannel = client.channels.cache.get(queue.textChannelId) ?? await client.channels.fetch(queue.textChannelId);
      if (textChannel && "send" in textChannel) {
        await (textChannel as any).send({ embeds: [nowPlayingEmbed(track, queue.tracks.length)] });
      }
    } catch (err) {
      console.error(`[Cathy] [Player] Failed to send now-playing embed:`, err);
    }

    console.log(`[Cathy] [Player] Now playing: "${track.title}" (Requested by: ${track.requestedBy} / ${track.requestedById}) in guild ${guildId}`);
  } catch (err) {
    console.error(`[Cathy] [Player] Failed to play "${track.title}" in guild ${guildId}:`, err);
    queue.playing = false;
    queue.tracks.shift();
    playNext(guildId);
  }
}

export function teardown(guildId: string): void {
  const queue = queues.get(guildId);
  if (!queue) return;
  if (queue.emptyChannelTimer) clearTimeout(queue.emptyChannelTimer);
  queue.player.removeAllListeners();
  queue.player.stop(true);
  queue.connection.destroy();
  queues.delete(guildId);
  console.log(`[Cathy] [Queue] Cleaned up voice queue and connection for guild ${guildId}`);
}

export function scheduleEmptyChannelLeave(guildId: string): void {
  const queue = queues.get(guildId);
  if (!queue) return;
  if (queue.emptyChannelTimer) clearTimeout(queue.emptyChannelTimer);
  console.log(`[Cathy] [Queue] Voice channel empty in guild ${guildId}. Scheduling auto-leave in ${EMPTY_CHANNEL_TIMEOUT_MS / 1000}s`);
  queue.emptyChannelTimer = setTimeout(() => {
    console.log(`[Cathy] [Queue] Voice channel remained empty in guild ${guildId} — auto-leaving channel.`);
    teardown(guildId);
  }, EMPTY_CHANNEL_TIMEOUT_MS);
}

export function cancelEmptyChannelLeave(guildId: string): void {
  const queue = queues.get(guildId);
  if (!queue || !queue.emptyChannelTimer) return;
  console.log(`[Cathy] [Queue] Member joined voice channel in guild ${guildId}. Canceled scheduled auto-leave.`);
  clearTimeout(queue.emptyChannelTimer);
  queue.emptyChannelTimer = null;
}
