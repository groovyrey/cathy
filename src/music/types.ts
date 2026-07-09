import { type AudioPlayer, type VoiceConnection } from "@discordjs/voice";

export interface QueueTrack {
  title: string;
  permalinkUrl: string;
  durationSec: number;
  requestedBy: string;
  requestedById: string;
  thumbnailUrl?: string;
}

export interface GuildQueue {
  tracks: QueueTrack[];
  player: AudioPlayer;
  connection: VoiceConnection;
  voiceChannelId: string;
  textChannelId: string;
  startedAt: number;
  emptyChannelTimer: ReturnType<typeof setTimeout> | null;
  playing: boolean;
}
