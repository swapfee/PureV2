/** Stable REST / reservation identifiers for Join-to-Create mutations. */

export function creationReservationId(eventId: string): string {
  return `j2c-res:${eventId}`;
}

export function creationRequestId(eventId: string): string {
  return `j2c-create:${eventId}`;
}

export function deletionRequestId(channelId: string, emptySinceMs: number): string {
  return `j2c-delete:${channelId}:${emptySinceMs}`;
}

export function moveRequestId(eventId: string): string {
  return `j2c-move:${eventId}`;
}

export function compensateDeleteRequestId(channelId: string, reservationId: string): string {
  return `j2c-compensate:${channelId}:${reservationId}`;
}
