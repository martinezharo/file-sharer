import { signal } from "@preact/signals";
import { allMessages, putMessage } from "../db/store";
import type { LocalMessage } from "../types";

export const messages = signal<LocalMessage[]>([]);

export async function loadMessages(): Promise<void> {
  messages.value = await allMessages();
}

/** Insert `message` into an array already sorted by `createdAt`, ascending. */
function insertSorted(list: LocalMessage[], message: LocalMessage): LocalMessage[] {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]!.createdAt <= message.createdAt) lo = mid + 1;
    else hi = mid;
  }
  const next = list.slice();
  next.splice(lo, 0, message);
  return next;
}

/**
 * Update the in-memory signal only. Used when the message is already persisted
 * (e.g. the service worker flushed the outbox and broadcast the new state).
 *
 * `createdAt` is assigned once at message creation and never changes, so an
 * update to an existing message can be applied in place without re-sorting.
 */
export function applyMessageUpdate(message: LocalMessage): void {
  const current = messages.value;
  const idx = current.findIndex((m) => m.id === message.id);
  if (idx !== -1) {
    const next = current.slice();
    next[idx] = message;
    messages.value = next;
    return;
  }
  messages.value = insertSorted(current, message);
}

/** Insert or update a message both in IndexedDB and the reactive signal. */
export async function upsertMessage(message: LocalMessage): Promise<void> {
  await putMessage(message);
  applyMessageUpdate(message);
}

export function getLocalMessage(id: string): LocalMessage | undefined {
  return messages.value.find((m) => m.id === id);
}
