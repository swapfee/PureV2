import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { existsSync } from "node:fs";

import type { VoiceStatsSnapshot } from "./service.ts";

export const STATS_CARD_WIDTH = 1_600;
export const STATS_CARD_HEIGHT = 900;
const CONTAINER_FONT_DIRECTORY = "/usr/share/fonts/truetype/dejavu";
let resolvedFontFamily: string | undefined;

export interface VoiceStatsCardData extends VoiceStatsSnapshot {
  readonly username: string;
  readonly serverName: string;
  readonly avatarData?: Uint8Array;
}

export interface VoiceStatsCardRenderer {
  render(snapshot: VoiceStatsCardData): Promise<Uint8Array>;
}

export function resolveStatsFontFamily(): string {
  if (resolvedFontFamily) return resolvedFontFamily;
  if (!GlobalFonts.has("DejaVu Sans") && existsSync(CONTAINER_FONT_DIRECTORY)) {
    GlobalFonts.loadFontsFromDir(CONTAINER_FONT_DIRECTORY);
  }
  const preferred = ["DejaVu Sans", "Arial", "Segoe UI"];
  resolvedFontFamily = preferred.find((family) => GlobalFonts.has(family))
    ?? GlobalFonts.families[0]?.family;
  if (!resolvedFontFamily) throw new Error("voice_stats_font_unavailable");
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

function roundedPath(context: SKRSContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function panel(context: SKRSContext2D, x: number, y: number, width: number, height: number, radius = 28): void {
  roundedPath(context, x, y, width, height, radius);
  const fill = context.createLinearGradient(x, y, x + width, y + height);
  fill.addColorStop(0, "#111111");
  fill.addColorStop(1, "#080808");
  context.fillStyle = fill;
  context.fill();
  context.strokeStyle = "#292929";
  context.lineWidth = 2;
  context.stroke();
}

function fitText(context: SKRSContext2D, value: string, maximumWidth: number): string {
  if (context.measureText(value).width <= maximumWidth) return value;
  let text = value;
  while (text.length > 1 && context.measureText(`${text}…`).width > maximumWidth) text = text.slice(0, -1);
  return `${text}…`;
}

function drawSummaryCard(context: SKRSContext2D, x: number, label: string, value: string): void {
  panel(context, x, 208, 492, 136);
  context.fillStyle = "#8f8f8f";
  context.font = font(17, 700);
  context.fillText(label, x + 30, 251);
  context.fillStyle = "#ffffff";
  context.font = font(42, 700);
  context.fillText(value, x + 30, 314);
}

function graphPoint(index: number, seconds: number, maximum: number): { readonly x: number; readonly y: number } {
  return {
    x: 105 + (850 * index) / 6,
    y: 786 - (seconds / maximum) * 265,
  };
}

function traceSmoothLine(context: SKRSContext2D, points: readonly { readonly x: number; readonly y: number }[]): void {
  if (points.length === 0) return;
  context.moveTo(points[0]!.x, points[0]!.y);
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    const midpoint = (previous.x + point.x) / 2;
    context.bezierCurveTo(midpoint, previous.y, midpoint, point.y, point.x, point.y);
  }
}

async function drawAvatar(context: SKRSContext2D, snapshot: VoiceStatsCardData): Promise<void> {
  const centerX = 100;
  const centerY = 104;
  const radius = 47;
  let renderedAvatar = false;
  context.save();
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.clip();
  if (snapshot.avatarData) {
    try {
      const avatar = await loadImage(snapshot.avatarData);
      context.drawImage(avatar, centerX - radius, centerY - radius, radius * 2, radius * 2);
      renderedAvatar = true;
    } catch {
      renderedAvatar = false;
    }
  }
  if (!renderedAvatar) {
    context.fillStyle = "#1c1c1c";
    context.fillRect(centerX - radius, centerY - radius, radius * 2, radius * 2);
  }
  context.restore();
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.strokeStyle = "#ffffff";
  context.lineWidth = 3;
  context.stroke();
  if (!renderedAvatar) {
    context.fillStyle = "#ffffff";
    context.font = font(38, 700);
    context.textAlign = "center";
    context.fillText(snapshot.displayName.trim().slice(0, 1).toUpperCase() || "?", centerX, centerY + 14);
    context.textAlign = "left";
  }
}

export function createVoiceStatsCardRenderer(): VoiceStatsCardRenderer {
  return {
    async render(snapshot) {
      const canvas = createCanvas(STATS_CARD_WIDTH, STATS_CARD_HEIGHT);
      const context = canvas.getContext("2d");
      const background = context.createLinearGradient(0, 0, STATS_CARD_WIDTH, STATS_CARD_HEIGHT);
      background.addColorStop(0, "#000000");
      background.addColorStop(0.52, "#030303");
      background.addColorStop(1, "#090909");
      context.fillStyle = background;
      context.fillRect(0, 0, STATS_CARD_WIDTH, STATS_CARD_HEIGHT);

      const glow = context.createRadialGradient(1_420, 80, 20, 1_420, 80, 520);
      glow.addColorStop(0, "rgba(255, 255, 255, 0.07)");
      glow.addColorStop(1, "rgba(255, 255, 255, 0)");
      context.fillStyle = glow;
      context.fillRect(880, 0, 720, 500);

      panel(context, 34, 30, 1_532, 150, 34);
      context.fillStyle = "#ffffff";
      context.font = font(39, 700);
      if (context.measureText("Voice statistics").width <= 0) throw new Error("voice_stats_font_cannot_render");
      context.fillText(fitText(context, snapshot.displayName, 690), 170, 86);
      context.fillStyle = "#aaaaaa";
      context.font = font(19, 700);
      context.fillText(fitText(context, `@${snapshot.username}`, 690), 170, 121);
      context.font = font(16);
      const since = snapshot.trackedSince
        ? `Tracked since ${snapshot.trackedSince.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`
        : "No tracked activity yet";
      context.fillText(since, 170, 151);

      await drawAvatar(context, snapshot);
      context.textAlign = "right";
      context.fillStyle = "#888888";
      context.font = font(15, 700);
      context.fillText("SERVER", 1_505, 91);
      context.fillStyle = "#ffffff";
      context.font = font(22, 700);
      context.fillText(fitText(context, snapshot.serverName, 430), 1_505, 126);
      context.textAlign = "left";

      drawSummaryCard(context, 34, "TOTAL VOICE TIME", duration(snapshot.totalSeconds));
      drawSummaryCard(context, 554, "SESSIONS", String(snapshot.sessionCount));
      drawSummaryCard(context, 1_074, "ACTIVE DAYS", String(snapshot.activeDays));

      panel(context, 34, 374, 1_010, 492);
      panel(context, 1_064, 374, 502, 492);
      context.fillStyle = "#ffffff";
      context.font = font(23, 700);
      context.fillText("Last 7 days", 70, 421);
      context.fillText("Top members", 1_100, 421);

      const maximumSeconds = Math.max(60, ...snapshot.daily.map((point) => point.seconds));
      context.font = font(15, 700);
      context.fillStyle = "#888888";
      context.textAlign = "right";
      for (let lineIndex = 0; lineIndex <= 3; lineIndex += 1) {
        const y = 786 - (265 * lineIndex) / 3;
        const value = (maximumSeconds * lineIndex) / 3;
        context.strokeStyle = "#242424";
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(105, y);
        context.lineTo(955, y);
        context.stroke();
        context.fillText(duration(value), 990, y + 5);
      }

      const points = snapshot.daily.map((point, index) => graphPoint(index, point.seconds, maximumSeconds));
      if (points.length > 0) {
        context.beginPath();
        traceSmoothLine(context, points);
        context.lineTo(points.at(-1)!.x, 786);
        context.lineTo(points[0]!.x, 786);
        context.closePath();
        const area = context.createLinearGradient(0, 510, 0, 790);
        area.addColorStop(0, "rgba(255, 255, 255, 0.24)");
        area.addColorStop(1, "rgba(255, 255, 255, 0.01)");
        context.fillStyle = area;
        context.fill();

        context.beginPath();
        traceSmoothLine(context, points);
        const graphLine = context.createLinearGradient(105, 0, 955, 0);
        graphLine.addColorStop(0, "#a0a0a0");
        graphLine.addColorStop(1, "#ffffff");
        context.strokeStyle = graphLine;
        context.lineWidth = 4;
        context.stroke();
        for (const point of points) {
          context.beginPath();
          context.arc(point.x, point.y, 6, 0, Math.PI * 2);
          context.fillStyle = "#0a0a0a";
          context.fill();
          context.strokeStyle = "#ffffff";
          context.lineWidth = 3;
          context.stroke();
        }
      }

      context.fillStyle = "#929292";
      context.font = font(15, 700);
      context.textAlign = "center";
      snapshot.daily.forEach((point, index) => {
        const x = 105 + (850 * index) / 6;
        context.fillText(point.day.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }), x, 824);
      });
      context.textAlign = "left";

      if (snapshot.leaderboard.length === 0) {
        context.fillStyle = "#929292";
        context.font = font(19);
        context.fillText("No tracked members yet.", 1_100, 486);
      } else {
        snapshot.leaderboard.slice(0, 5).forEach((member, index) => {
          const y = 452 + index * 73;
          roundedPath(context, 1_092, y, 446, 58, 18);
          const row = context.createLinearGradient(1_092, 0, 1_538, 0);
          row.addColorStop(0, index === 0 ? "#252525" : "#161616");
          row.addColorStop(1, "#0b0b0b");
          context.fillStyle = row;
          context.fill();
          context.strokeStyle = index === 0 ? "#666666" : "#2d2d2d";
          context.lineWidth = 2;
          context.stroke();
          context.fillStyle = "#9b9b9b";
          context.font = font(17, 700);
          context.fillText(String(index + 1), 1_112, y + 37);
          context.fillStyle = "#ffffff";
          context.fillText(fitText(context, member.displayName, 245), 1_150, y + 37);
          context.textAlign = "right";
          context.fillText(duration(member.totalSeconds), 1_515, y + 37);
          context.textAlign = "left";
        });
      }

      return canvas.toBuffer("image/png");
    },
  };
}
