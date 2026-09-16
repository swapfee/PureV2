import type { TemporaryChannelRecord } from "../../models/temporary-channel.ts";
import type { TemporaryChannelRepository } from "./repositories.ts";

export interface OwnershipService {
  findOwnedChannel(guildId: string, ownerId: string): Promise<TemporaryChannelRecord | undefined>;
  isOwner(channelId: string, userId: string): Promise<boolean>;
  assertOwner(channelId: string, userId: string): Promise<TemporaryChannelRecord>;
}

export class OwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnershipError";
  }
}

export function createOwnershipService(channels: TemporaryChannelRepository): OwnershipService {
  return {
    async findOwnedChannel(guildId, ownerId) {
      return channels.findActiveOrCreatingByOwner(guildId, ownerId);
    },

    async isOwner(channelId, userId) {
      const channel = await channels.findByChannelId(channelId);
      return channel !== undefined && channel.ownerId === userId && channel.status === "active";
    },

    async assertOwner(channelId, userId) {
      const channel = await channels.findByChannelId(channelId);
      if (!channel || channel.status !== "active") {
        throw new OwnershipError("Temporary channel not found or inactive");
      }
      if (channel.ownerId !== userId) {
        throw new OwnershipError("Only the channel owner may perform this action");
      }
      return channel;
    },
  };
}
