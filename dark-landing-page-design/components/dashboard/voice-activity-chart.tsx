"use client"

import { useId } from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import type { ActivityPoint } from "@/lib/dashboard/contracts"

function formatMinutes(value: number): string {
  if (value < 60) return `${value}m`

  const hours = Math.floor(value / 60)
  const minutes = value % 60
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

function formatAxisMinutes(value: number): string {
  if (value < 60) return `${value}m`
  const hours = value / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
}

export function VoiceActivityChart({ data }: { data: readonly ActivityPoint[] }) {
  const gradientId = `voice-activity-${useId().replaceAll(":", "")}`
  const maximum = Math.max(60, ...data.map((point) => point.minutes))
  const domainMaximum = Math.ceil(maximum / 60) * 60

  return (
    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
      <AreaChart
        accessibilityLayer
        data={data}
        margin={{ top: 12, right: 4, bottom: 0, left: 4 }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity={0.2} />
            <stop offset="72%" stopColor="#ffffff" stopOpacity={0.035} />
            <stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
          </linearGradient>
        </defs>

        <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.07)" strokeDasharray="3 5" />
        <XAxis
          axisLine={false}
          dataKey="label"
          interval={data.length > 14 ? 4 : 0}
          padding={{ left: 12, right: 8 }}
          tick={{ fill: "rgba(255,255,255,0.46)", fontSize: 10 }}
          tickLine={false}
          tickMargin={14}
        />
        <YAxis
          axisLine={false}
          domain={[0, domainMaximum]}
          orientation="right"
          tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }}
          tickCount={5}
          tickFormatter={formatAxisMinutes}
          tickLine={false}
          tickMargin={10}
          width={42}
        />
        <Tooltip
          contentStyle={{
            background: "#090909",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 10,
            boxShadow: "0 16px 36px rgba(0,0,0,0.38)",
            color: "white",
            fontSize: 11,
          }}
          cursor={{ stroke: "rgba(255,255,255,0.16)", strokeDasharray: "3 4" }}
          formatter={(value) => [formatMinutes(Number(value)), "Voice time"]}
          itemStyle={{ color: "white" }}
          labelStyle={{ color: "rgba(255,255,255,0.56)", marginBottom: 4 }}
        />
        <Area
          activeDot={{ fill: "#ffffff", r: 4, stroke: "#070707", strokeWidth: 2 }}
          dataKey="minutes"
          dot={{ fill: "#0d0d0d", r: 3, stroke: "#ffffff", strokeWidth: 1.5 }}
          fill={`url(#${gradientId})`}
          isAnimationActive={false}
          name="Voice time"
          stroke="#ffffff"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          type="monotoneX"
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
