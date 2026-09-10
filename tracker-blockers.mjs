/**
 * One-shot: blocking is by task only. Kept for reference.
 *
 * Ethan's call: blocked shouldn't be a description box. You pick the tasks
 * something waits on, and the block goes to their owners. So the free-text
 * reason is cleared everywhere, and every status is synced to its links.
 *
 * On the live board only Avantis carried text ("Venue integration doc"); it is
 * also linked to the technical docs, so it stays blocked, and the venue
 * integration doc is still named in its title.
 */
import { syncBlocked } from './tracker.js';

export function tasksOnlyBlocking(tracker) {
  const cleared = [];
  for (const t of tracker.tasks) {
    if ('blocked_by' in t) {
      if (t.blocked_by?.trim()) cleared.push(`${t.title}: "${t.blocked_by}"`);
      delete t.blocked_by;
    }
    t.status_before_block ??= '';
  }
  const synced = syncBlocked(tracker);
  return { cleared, synced };
}
