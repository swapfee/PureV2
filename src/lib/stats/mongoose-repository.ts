import { VoiceDailyStatsModel, type VoiceDailyStatsRecord } from "../../models/voice-daily-stats.ts";
import { VoiceMemberStatsModel, type VoiceMemberStatsDocument, type VoiceMemberStatsRecord } from "../../models/voice-member-stats.ts";
import { VoiceStatsEventModel } from "../../models/voice-stats-event.ts";
import { VoiceStatsSessionModel, type VoiceStatsSessionDocument, type VoiceStatsSessionRecord } from "../../models/voice-stats-session.ts";
import { splitDurationByUtcDay, utcDayStart, type OpenVoiceStatsSessionInput, type VoiceStatsRepository } from "./repositories.ts";

const RAW_RETENTION_MS = 90 * 86_400_000;
const EVENT_RETENTION_MS = 7 * 86_400_000;

function sessionRecord(doc: VoiceStatsSessionDocument): VoiceStatsSessionRecord {
  return {
    sessionId: doc.sessionId, guildId: doc.guildId, userId: doc.userId,
    channelId: doc.channelId, status: doc.status,
    startedAt: doc.startedAt, lastConfirmedAt: doc.lastConfirmedAt,
    durationSeconds: doc.durationSeconds, joinEventId: doc.joinEventId,
    ...(doc.endedAt ? { endedAt: doc.endedAt } : {}),
    ...(doc.leaveEventId ? { leaveEventId: doc.leaveEventId } : {}),
    ...(doc.expiresAt ? { expiresAt: doc.expiresAt } : {}),
  };
}

function memberRecord(doc: VoiceMemberStatsDocument): VoiceMemberStatsRecord {
  return {
    guildId: doc.guildId, userId: doc.userId, totalSeconds: doc.totalSeconds,
    sessionCount: doc.sessionCount, firstTrackedAt: doc.firstTrackedAt,
    lastActivityAt: doc.lastActivityAt,
    ...(typeof doc.lastKnownDisplayName === "string" ? { lastKnownDisplayName: doc.lastKnownDisplayName } : {}),
  };
}

export function createMongooseVoiceStatsRepository(): VoiceStatsRepository {
  return {
    async acquireEvent(eventId, guildId, userId, at, processingOwner) {
      const retry = await VoiceStatsEventModel.updateOne(
        { eventId, $or: [{ status: "failed" }, { status: "processing", processingOwner: { $ne: processingOwner } }] },
        { $set: { guildId, userId, status: "processing", processingOwner, expiresAt: new Date(at.getTime() + EVENT_RETENTION_MS) }, $unset: { failureReason: 1 } },
      );
      if (retry.modifiedCount === 1) return true;
      try {
        await VoiceStatsEventModel.create({ eventId, guildId, userId, status: "processing", processingOwner, expiresAt: new Date(at.getTime() + EVENT_RETENTION_MS) });
        return true;
      } catch (error) {
        if (typeof error === "object" && error !== null && Reflect.get(error, "code") === 11000) return false;
        throw error;
      }
    },
    async completeEvent(eventId) { await VoiceStatsEventModel.updateOne({ eventId }, { $set: { status: "completed" }, $unset: { failureReason: 1 } }); },
    async failEvent(eventId, reason) { await VoiceStatsEventModel.updateOne({ eventId }, { $set: { status: "failed", failureReason: reason.slice(0, 500) } }); },
    async findActive(guildId, userId) {
      const doc = await VoiceStatsSessionModel.findOne({ guildId, userId, status: "active" }).lean();
      return doc ? sessionRecord(doc) : undefined;
    },
    async listActiveByGuild(guildId) {
      const docs = await VoiceStatsSessionModel.find({ guildId, status: "active" }).lean();
      return docs.map(sessionRecord);
    },
    async listGuildSessionsOverlapping(guildId, from, to) {
      const docs = await VoiceStatsSessionModel.find({
        guildId,
        startedAt: { $lt: to },
        $or: [{ status: "active" }, { endedAt: { $gt: from } }],
      }).sort({ startedAt: 1 }).lean();
      return docs.map(sessionRecord);
    },
    async listMemberSessionsOverlapping(guildId, userId, from, to) {
      const docs = await VoiceStatsSessionModel.find({
        guildId,
        userId,
        startedAt: { $lt: to },
        $or: [{ status: "active" }, { endedAt: { $gt: from } }],
      }).sort({ startedAt: 1 }).lean();
      return docs.map(sessionRecord);
    },
    async open(input: OpenVoiceStatsSessionInput) {
      let created: VoiceStatsSessionDocument | undefined;
      await VoiceStatsSessionModel.db.transaction(async (mongoSession) => {
        const docs = await VoiceStatsSessionModel.create([{
          sessionId: input.sessionId, guildId: input.guildId, userId: input.userId, channelId: input.channelId,
          status: "active", startedAt: input.at, lastConfirmedAt: input.at, durationSeconds: 0, joinEventId: input.eventId,
        }], { session: mongoSession });
        created = docs[0];
        await VoiceMemberStatsModel.updateOne(
          { guildId: input.guildId, userId: input.userId },
          {
            $setOnInsert: { firstTrackedAt: input.at, totalSeconds: 0 },
            $set: { lastActivityAt: input.at, ...(input.displayName ? { lastKnownDisplayName: input.displayName.slice(0, 100) } : {}) },
            $inc: { sessionCount: 1 },
          },
          { upsert: true, session: mongoSession },
        );
        await VoiceDailyStatsModel.updateOne(
          { guildId: input.guildId, userId: input.userId, day: utcDayStart(input.at) },
          { $inc: { sessionCount: 1, durationSeconds: 0 } }, { upsert: true, session: mongoSession },
        );
      });
      if (!created) throw new Error("voice_stats_session_transaction_did_not_create");
      return sessionRecord(created);
    },
    async close(guildId, userId, eventId, at) {
      let closed: VoiceStatsSessionDocument | undefined;
      await VoiceStatsSessionModel.db.transaction(async (mongoSession) => {
        const existing = await VoiceStatsSessionModel.findOne({ guildId, userId, status: "active" }).session(mongoSession).lean();
        if (!existing) return;
        const startedAt = new Date(existing.startedAt);
        const seconds = Math.max(0, Math.floor((at.getTime() - startedAt.getTime()) / 1000));
        const updated = await VoiceStatsSessionModel.findOneAndUpdate(
          { sessionId: existing.sessionId, status: "active" },
          { $set: { status: "completed", endedAt: at, lastConfirmedAt: at, durationSeconds: seconds, leaveEventId: eventId, expiresAt: new Date(at.getTime() + RAW_RETENTION_MS) } },
          { new: true, session: mongoSession },
        ).lean();
        if (!updated) return;
        closed = updated;
        await VoiceMemberStatsModel.updateOne(
          { guildId, userId },
          { $inc: { totalSeconds: seconds }, $set: { lastActivityAt: at } },
          { session: mongoSession },
        );
        for (const part of splitDurationByUtcDay(startedAt, at)) {
          await VoiceDailyStatsModel.updateOne(
            { guildId, userId, day: part.day },
            { $inc: { durationSeconds: part.seconds, sessionCount: 0 } },
            { upsert: true, session: mongoSession },
          );
        }
      });
      return closed ? sessionRecord(closed) : undefined;
    },
    async checkpoint(guildId, userId, at) { await VoiceStatsSessionModel.updateOne({ guildId, userId, status: "active" }, { $set: { lastConfirmedAt: at } }); },
    async getMember(guildId, userId) {
      const doc = await VoiceMemberStatsModel.findOne({ guildId, userId }).lean();
      return doc ? memberRecord(doc) : undefined;
    },
    async getDaily(guildId, userId, from, to) {
      const docs = await VoiceDailyStatsModel.find({ guildId, userId, day: { $gte: from, $lte: to } }).sort({ day: 1 }).lean();
      return docs.map((doc) => ({ guildId: doc.guildId, userId: doc.userId, day: doc.day, durationSeconds: doc.durationSeconds, sessionCount: doc.sessionCount } satisfies VoiceDailyStatsRecord));
    },
    async getGuildDaily(guildId, from, to) {
      const docs = await VoiceDailyStatsModel.aggregate<{
        day: Date;
        durationSeconds: number;
        sessionCount: number;
      }>([
        { $match: { guildId, day: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: "$day",
            durationSeconds: { $sum: "$durationSeconds" },
            sessionCount: { $sum: "$sessionCount" },
          },
        },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, day: "$_id", durationSeconds: 1, sessionCount: 1 } },
      ]);
      return docs.map((doc) => ({
        day: doc.day,
        durationSeconds: doc.durationSeconds,
        sessionCount: doc.sessionCount,
      }));
    },
    async countActiveDays(guildId, userId) { return VoiceDailyStatsModel.countDocuments({ guildId, userId, $or: [{ durationSeconds: { $gt: 0 } }, { sessionCount: { $gt: 0 } }] }); },
    async getLeaderboard(guildId, limit) {
      const docs = await VoiceMemberStatsModel.find({ guildId }).sort({ totalSeconds: -1, userId: 1 }).limit(limit).lean();
      return docs.map(memberRecord);
    },
    async purgeGuild(guildId) {
      let result = { sessions: 0, members: 0, daily: 0, events: 0 };
      await VoiceStatsSessionModel.db.transaction(async (mongoSession) => {
        // MongoDB does not support parallel operations within one transaction.
        const sessions = await VoiceStatsSessionModel.deleteMany(
          { guildId },
          { session: mongoSession },
        );
        const members = await VoiceMemberStatsModel.deleteMany(
          { guildId },
          { session: mongoSession },
        );
        const daily = await VoiceDailyStatsModel.deleteMany(
          { guildId },
          { session: mongoSession },
        );
        const events = await VoiceStatsEventModel.deleteMany(
          { guildId },
          { session: mongoSession },
        );
        result = {
          sessions: sessions.deletedCount,
          members: members.deletedCount,
          daily: daily.deletedCount,
          events: events.deletedCount,
        };
      });
      return result;
    },
  };
}
