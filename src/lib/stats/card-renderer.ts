import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { existsSync } from "node:fs";

import type { VoiceStatsSnapshot } from "./service.ts";

export const STATS_CARD_WIDTH = 1_600;
export const STATS_CARD_HEIGHT = 900;
const CONTAINER_FONT_DIRECTORY = "/usr/share/fonts/truetype/dejavu";
let resolvedFontFamily: string | undefined;

export function resolveStatsFontFamily(): string {
  if (resolvedFontFamily) return resolvedFontFamily;
  if (!GlobalFonts.has("DejaVu Sans") && existsSync(CONTAINER_FONT_DIRECTORY)) {
    GlobalFonts.loadFontsFromDir(CONTAINER_FONT_DIRECTORY);
  }
  const preferred = ["DejaVu Sans", "Arial", "Segoe UI"];
  resolvedFontFamily = preferred.find((family) => GlobalFonts.has(family))
    ?? GlobalFonts.families[0]?.family;
  if (!resolvedFontFamily) {
    throw new Error("voice_stats_font_unavailable");
  }
  return resolvedFontFamily;
}

function font(size: number, weight = 400): string {
  return `${weight} ${size}px "${resolveStatsFontFamily()}"`;
}

function duration(value: number): string {
  const hours = Math.floor(value / 3_600);
  const minutes = Math.floor((value % 3_600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function roundedRect(context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>, x: number, y: number, width: number, height: number, radius = 24): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
  context.stroke();
}

export interface VoiceStatsCardRenderer {
  render(snapshot: VoiceStatsSnapshot): Promise<Uint8Array>;
}

export function createVoiceStatsCardRenderer(): VoiceStatsCardRenderer {
  return {
    async render(snapshot) {
      const canvas = createCanvas(STATS_CARD_WIDTH, STATS_CARD_HEIGHT);
      const context = canvas.getContext("2d");
      context.fillStyle = "#08090b";
      context.fillRect(0, 0, STATS_CARD_WIDTH, STATS_CARD_HEIGHT);
      context.strokeStyle = "#252830";
      context.lineWidth = 2;
      context.fillStyle = "#111318";
      roundedRect(context, 45, 40, 1_510, 150, 32);
      context.fillStyle = "#20232a";
      roundedRect(context, 78, 72, 88, 88, 26);
      context.fillStyle = "#aeb4c2";
      context.font = font(46, 700);
      if (context.measureText("Voice statistics").width <= 0) {
        throw new Error("voice_stats_font_cannot_render");
      }
      context.textAlign = "center";
      context.fillText(snapshot.displayName.trim().slice(0, 1).toUpperCase() || "?", 122, 132);
      context.textAlign = "left";
      context.fillStyle = "#f4f5f8";
      context.font = font(39, 700);
      context.fillText(snapshot.displayName.slice(0, 42), 195, 112);
      context.fillStyle = "#9aa0ae";
      context.font = font(22);
      const since = snapshot.trackedSince ? snapshot.trackedSince.toISOString().slice(0, 10) : "No tracked activity yet";
      context.fillText(snapshot.trackedSince ? `Tracked since ${since}` : since, 195, 148);

      const cards = [
        ["TOTAL VOICE TIME", duration(snapshot.totalSeconds)],
        ["SESSIONS", String(snapshot.sessionCount)],
        ["ACTIVE DAYS", String(snapshot.activeDays)],
      ] as const;
      for (const [index, [label, value]] of cards.entries()) {
        const x = 45 + index * 505;
        context.fillStyle = "#111318"; context.strokeStyle = "#252830";
        roundedRect(context, x, 215, 475, 135, 28);
        context.fillStyle = "#8e94a2"; context.font = font(18, 700);
        context.fillText(label, x + 28, 255);
        context.fillStyle = "#f4f5f8"; context.font = font(43, 700);
        context.fillText(value, x + 28, 318);
      }

      context.fillStyle = "#111318"; context.strokeStyle = "#252830";
      roundedRect(context, 45, 375, 995, 475, 28);
      roundedRect(context, 1_065, 375, 490, 475, 28);
      context.fillStyle = "#f4f5f8"; context.font = font(24, 700);
      context.fillText("Last 7 days", 75, 420);
      context.fillText("Top members", 1_095, 420);

      const graphX = 95; const graphY = 790; const graphWidth = 885; const graphHeight = 290;
      const max = Math.max(60, ...snapshot.daily.map((point) => point.seconds));
      context.strokeStyle = "#262a32"; context.lineWidth = 1;
      for (let line = 0; line <= 3; line += 1) {
        const y = graphY - (graphHeight * line) / 3;
        context.beginPath(); context.moveTo(graphX, y); context.lineTo(graphX + graphWidth, y); context.stroke();
      }
      context.strokeStyle = "#c5cad5"; context.lineWidth = 4; context.beginPath();
      snapshot.daily.forEach((point, index) => {
        const x = graphX + (graphWidth * index) / 6;
        const y = graphY - (point.seconds / max) * graphHeight;
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
      context.stroke();
      context.fillStyle = "#9aa0ae"; context.font = font(17); context.textAlign = "center";
      snapshot.daily.forEach((point, index) => {
        const x = graphX + (graphWidth * index) / 6;
        context.fillText(point.day.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }), x, 825);
      });
      context.textAlign = "left";

      if (snapshot.leaderboard.length === 0) {
        context.fillStyle = "#8e94a2"; context.font = font(21);
        context.fillText("No tracked members yet.", 1_095, 485);
      } else {
        snapshot.leaderboard.forEach((member, index) => {
          const y = 470 + index * 70;
          context.fillStyle = "#1a1d23"; context.strokeStyle = "#30343e";
          roundedRect(context, 1_090, y - 34, 440, 56, 16);
          context.fillStyle = "#9aa0ae"; context.font = font(18, 700);
          context.fillText(String(index + 1), 1_110, y + 2);
          context.fillStyle = "#e7e9ef";
          context.fillText(member.displayName.slice(0, 23), 1_145, y + 2);
          context.textAlign = "right";
          context.fillText(duration(member.totalSeconds), 1_505, y + 2);
          context.textAlign = "left";
        });
      }
      return canvas.toBuffer("image/png");
    },
  };
}
