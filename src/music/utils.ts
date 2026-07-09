import { EmbedBuilder, Colors } from "discord.js";
import { spawn } from "child_process";
import ffmpegStatic from "ffmpeg-static";
import type { QueueTrack } from "./types";

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

export const YTDLP_PATH: string = getYtDlpPath();
export const FFMPEG_PATH: string = ffmpegStatic as string;

export function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "Live";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export async function getYtMetadata(query: string): Promise<QueueTrack | null> {
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
        const video = Array.isArray(data) ? data[0] : data;

        if (!video) return resolve(null);

        resolve({
          title: video.title ?? "Unknown Title",
          permalinkUrl: video.webpage_url ?? query,
          durationSec: video.duration ?? 0,
          requestedBy: "",
          requestedById: "",
          thumbnailUrl: video.thumbnail,
        });
      } catch (e) {
        console.error(`[Cathy] [yt-dlp] JSON parse error:`, e);
        resolve(null);
      }
    });
  });
}

export function nowPlayingEmbed(track: QueueTrack, queueLength: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle("🎧 Cathy's Current Jam")
    .setDescription(`**[${track.title}](${track.permalinkUrl})**`)
    .addFields(
      { name: "Duration", value: formatDuration(track.durationSec), inline: true },
      { name: "Requested by", value: `<@${track.requestedById}>`, inline: true },
      { name: "Up next", value: queueLength > 1 ? `${queueLength - 1} more songs coming up! ✨` : "That's it for now! Queue's empty! 🌈", inline: true },
    )
    .setImage(track.thumbnailUrl ?? null)
    .setFooter({ text: "YouTube • Jamming with Cathy 🎵" })
    .setTimestamp();
}

export function addedEmbed(track: QueueTrack, position: number): EmbedBuilder {
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
