import { SlashCommandBuilder } from "discord.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check if Cathy is still awake and kicking! 🏓"),
  new SlashCommandBuilder()
    .setName("echo")
    .setDescription("Make Cathy repeat whatever you say! (She's a great mimic 😜)")
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription("The message for Cathy to repeat.")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("talk")
    .setDescription("Chat with Cathy! (Powered by Gemma 4 💖)")
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription("What do you want to tell Cathy?")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Let Cathy play some tunes from YouTube for you! 🎵")
    .addStringOption((option) =>
      option
        .setName("song")
        .setDescription("Song name, YouTube URL, or search query.")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("What's Cathy playing right now? 🎧"),
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show me the whole music list! 📜"),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip this song! Next one, please! ⏭️"),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Get rid of a song from the list. 🗑️")
    .addIntegerOption((option) =>
      option
        .setName("position")
        .setDescription("Queue position to remove (1 = first queued track, not the one playing).")
        .setMinValue(1)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Hold on! Pause the music. ⏸️"),
  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Okay, back to the music! ▶️"),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop everything and let Cathy go home. ⏹️"),
  new SlashCommandBuilder()
    .setName("about")
    .setDescription("Wanna know more about Cathy and the person who made her? 🌧️"),
];

export const commandPayloads = commands.map((command) => command.toJSON());
