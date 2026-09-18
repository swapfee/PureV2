/** Stable REST / reservation identifiers for Join-to-Create mutations. */

export function creationReservationId(eventId: string): string {
  return `j2c-res:${eventId}`;
}

export function creationRequestId(eventId: string): string {
  return `j2c-create:${eventId}`;
}

export function channelPositionRequestId(eventId: string): string {
  return `j2c-position:${eventId}`;
}

export function deletionRequestId(channelId: string, emptySinceMs: number): string {
  return `j2c-delete:${channelId}:${emptySinceMs}`;
}

/** Stable synthetic event for retrying a lobby join after the owner's old channel is deleted. */
export function creationRetryAfterDeletionEventId(channelId: string): string {
  return `j2c-retry-delete:${channelId}`;
}

export function moveRequestId(eventId: string): string {
  return `j2c-move:${eventId}`;
}

export function compensateDeleteRequestId(channelId: string, reservationId: string): string {
  return `j2c-compensate:${channelId}:${reservationId}`;
}
