import type { CreationReservationRecord } from "../../models/creation-reservation.ts";
import type { J2cMetrics } from "./metrics.ts";
import type { CreationReservationRepository, TemporaryChannelRepository } from "./repositories.ts";

export const DEFAULT_RESERVATION_TTL_MS = 60_000;

export type ReservationDecision =
  | { readonly outcome: "acquired"; readonly reservation: CreationReservationRecord }
  | { readonly outcome: "duplicate_in_flight"; readonly reservation: CreationReservationRecord }
  | { readonly outcome: "replay"; readonly reservation: CreationReservationRecord }
  | { readonly outcome: "owner_has_channel"; readonly channelId: string };

export interface ReservationService {
  beginCreation(input: {
    readonly reservationId: string;
    readonly guildId: string;
    readonly memberId: string;
    readonly eventId: string;
    readonly creationRequestId: string;
    readonly ttlMs?: number;
  }): Promise<ReservationDecision>;
  complete(reservationId: string, channelId: string): Promise<void>;
  fail(reservationId: string, reason: string): Promise<void>;
  expireDue(): Promise<number>;
}

export function createReservationService(options: {
  readonly reservations: CreationReservationRepository;
  readonly channels: TemporaryChannelRepository;
  readonly metrics: J2cMetrics;
  readonly now?: () => Date;
}): ReservationService {
  const now = options.now ?? (() => new Date());

  return {
    async beginCreation(input) {
      const existingChannel = await options.channels.findBlockingOwnedChannel(
        input.guildId,
        input.memberId,
      );
      if (existingChannel) {
        options.metrics.increment("duplicateCreationsPrevented");
        return { outcome: "owner_has_channel", channelId: existingChannel.channelId };
      }

      const expiresAt = new Date(now().getTime() + (input.ttlMs ?? DEFAULT_RESERVATION_TTL_MS));
      const result = await options.reservations.acquire({
        reservationId: input.reservationId,
        guildId: input.guildId,
        memberId: input.memberId,
        eventId: input.eventId,
        creationRequestId: input.creationRequestId,
        expiresAt,
      });

      if (result.outcome === "already_reserved") {
        options.metrics.increment("duplicateCreationsPrevented");
        return { outcome: "duplicate_in_flight", reservation: result.reservation };
      }
      if (result.outcome === "replay") {
        return { outcome: "replay", reservation: result.reservation };
      }
      return { outcome: "acquired", reservation: result.reservation };
    },

    async complete(reservationId, channelId) {
      await options.reservations.complete(reservationId, channelId);
    },

    async fail(reservationId, reason) {
      await options.reservations.fail(reservationId, reason);
    },

    async expireDue() {
      return options.reservations.expireDue(now());
    },
  };
}
