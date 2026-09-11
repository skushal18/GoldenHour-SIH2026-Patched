/* ============================================================================
   The offline outbox.

   The scenario: a crew fills in a case in an underground car park, presses
   Broadcast, and the POST fails. Today's answer is an error sheet with a
   Retry button — which puts the job of noticing on the one person who has
   both hands busy. So a network failure queues the case and the app sends it
   itself the moment there is a signal.

   Two rules keep that from doing harm:
     * A 4xx is not queued. The server said the payload is wrong; retrying it
       forever will not make it right.
     * A queued case older than STALE_MS is never sent silently. The patient
       may already be at a hospital, and a phantom ambulance on two ER boards
       is worse than a failed send.
   ========================================================================== */

export const OUTBOX_KEY = 'goldenhour.outbox';
export const MAX_QUEUED = 3;
export const STALE_MS = 15 * 60 * 1000;

export function createOutbox(storage, options) {
  const opts = options || {};
  let entries = read();

  function read() {
    try {
      const raw = storage.getItem(OUTBOX_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.slice(0, MAX_QUEUED) : [];
    } catch (_) { return []; }
  }

  function persist() {
    try { storage.setItem(OUTBOX_KEY, JSON.stringify(entries.slice(0, MAX_QUEUED))); return true; }
    catch (err) {
      /* Quota: four compressed photos is up to half a megabyte of base64 and
         the quota is shared with everything else on the origin. Drop the
         photos from the oldest case first — the clinical payload is what
         matters — and only refuse the enqueue if even that will not fit. */
      const stripped = entries.slice().reverse().find(e => e.payload && e.payload.images && e.payload.images.length);
      if (stripped) {
        stripped.payload.images = [];
        stripped.photos_dropped = true;
        try { storage.setItem(OUTBOX_KEY, JSON.stringify(entries.slice(0, MAX_QUEUED))); return true; }
        catch (_) { /* fall through */ }
      }
      return false;
    }
  }

  return {
    all() { return entries.slice(); },
    count() { return entries.length; },
    isEmpty() { return entries.length === 0; },

    /** @returns true if the case is safely queued, false if it could not be. */
    enqueue(payload) {
      const entry = {
        id: 'ob-' + Date.now() + '-' + Math.floor(Math.random() * 1e6).toString(36),
        payload,
        created_at: new Date().toISOString(),
        attempts: 0,
        last_error: null,
        last_attempt_at: null,
      };
      entries.unshift(entry);
      entries = entries.slice(0, MAX_QUEUED);
      return persist() ? entry : (entries = entries.filter(e => e !== entry), false);
    },

    remove(id) { entries = entries.filter(e => e.id !== id); persist(); },
    clear() { entries = []; persist(); },

    stale(now) {
      const cutoff = (now || Date.now()) - STALE_MS;
      return entries.filter(e => new Date(e.created_at).getTime() <= cutoff);
    },

    /**
     * Try to send everything that is not stale. `send` is the transport's
     * broadcast(payload, clientRequestId) — reusing the entry id as the
     * idempotency key is what stops a double flush creating two cases.
     */
    async flush(send, now) {
      if (!entries.length) return { sent: [], kept: entries.length, stale: this.stale(now).length };
      const cutoff = (now || Date.now()) - STALE_MS;
      const sent = [];
      const keep = [];
      for (const entry of entries) {
        if (new Date(entry.created_at).getTime() <= cutoff) { keep.push(entry); continue; }
        try {
          const res = await send(entry.payload, entry.id);
          sent.push({ entry, response: res });
        } catch (err) {
          entry.attempts += 1;
          entry.last_attempt_at = new Date().toISOString();
          entry.last_error = (err && err.message) || 'unknown';
          /* A refusal is final. Anything else is worth another try. */
          if (err && err.status >= 400 && err.status < 500) {
            if (opts.onRejected) opts.onRejected(entry, err);
          } else {
            keep.push(entry);
          }
        }
      }
      entries = keep;
      persist();
      return { sent, kept: entries.length, stale: this.stale(now).length };
    },
  };
}
