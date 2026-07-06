import { execFile } from "child_process";
import { promisify } from "util";
import ffmpegStatic from "ffmpeg-static";
import { spawn } from "child_process";

const execFileAsync = promisify(execFile);
const YTDLP_PATH = "/home/azureuser/.local/bin/yt-dlp";
const FFMPEG_PATH = ffmpegStatic as string;

async function test() {
  const videoUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  
  console.log("Getting audio URL from yt-dlp...");
  const { stdout } = await execFileAsync(YTDLP_PATH, [
    "--format", "bestaudio[ext=webm]/bestaudio/best",
    "--no-playlist",
    "--get-url",
    videoUrl,
  ]);
  const audioUrl = stdout.trim().split("\n")[0];
  console.log("Got audio URL:", audioUrl.substring(0, 80) + "...");
  
  console.log("Launching ffmpeg (will produce 3 seconds of ogg opus)...");
  const ffmpegArgs = [
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-i", audioUrl,
    "-analyzeduration", "0",
    "-loglevel", "error",
    "-vn",
    "-ac", "2",
    "-ar", "48000",
    "-c:a", "libopus",
    "-b:a", "128k",
    "-f", "ogg",
    "-t", "3",  // only 3 seconds for the test
    "/tmp/cathy_test.ogg",  // write to file instead of pipe for the test
  ];
  
  await new Promise<void>((resolve, reject) => {
    const ffmpegProc = spawn(FFMPEG_PATH, ffmpegArgs, { stdio: ["ignore", "inherit", "pipe"] });
    let stderrOutput = "";
    ffmpegProc.stderr.on("data", (d: Buffer) => {
      stderrOutput += d.toString();
    });
    ffmpegProc.on("exit", (code) => {
      if (stderrOutput.trim()) console.error("[ffmpeg stderr]:", stderrOutput.trim());
      if (code === 0) {
        console.log("✅ SUCCESS: ffmpeg encoded 3 seconds of audio (code 0)");
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
  
  // Check file size
  const { statSync } = require("fs");
  const stats = statSync("/tmp/cathy_test.ogg");
  console.log(`Output file size: ${stats.size} bytes`);
  if (stats.size > 1000) {
    console.log("✅ File has content — the full yt-dlp → ffmpeg → OGG Opus pipeline works!");
  }
}

test().catch(console.error);
