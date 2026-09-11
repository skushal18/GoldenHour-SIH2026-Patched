/* ============================================================================
   Recent cases, kept on the device.

   The Home screen has to answer "what is happening right now?" in one or two
   seconds, including straight after the app is killed and reopened — which is
   exactly what happens when a phone is dropped on a stretcher. That answer
   cannot depend on the network, so the crew's own recent cases live here.

   Deliberately minimal: case code, type, age band, sex, status, timestamps.
   No name, no address, no free-text notes. A stolen phone should not be a
   patient-data incident.
   ========================================================================== */

export const CASES_KEY = 'goldenhour.cases';
export const MAX_KEPT = 12;

const OPEN_STATUSES = ['PENDING', 'ACCEPTED'];

/* How long an arrived case stays on the Home screen as confirmation. */
const RECENT_ARRIVAL_MS = 5 * 60 * 1000;

export function createCaseBook(storage) {
  let items = read();

  function read() {
    try {
      const raw = storage.getItem(CASES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.slice(0, MAX_KEPT) : [];
    } catch (_) { return []; }
  }
  function persist() {
    try { storage.setItem(CASES_KEY, JSON.stringify(items.slice(0, MAX_KEPT))); } catch (_) {}
  }

  return {
    all() { return items.slice(); },

    /** The one case the crew is currently running, if any. */
    active() {
      return items.find(c => OPEN_STATUSES.indexOf(c.status) !== -1) || null;
    },

    /**
     * What the Home screen should show.
     *
     * An open case, or — when there is none — a case that arrived in the last
     * few minutes. Without the second half, tapping "Reached hospital" made
     * the entire card vanish along with the confirmation that the arrival had
     * been recorded at all, which is the one moment the crew most needs to
     * see it. It clears itself; nothing has to be dismissed.
     */
    current(now) {
      const open = this.active();
      if (open) return open;
      const cutoff = (now || Date.now()) - RECENT_ARRIVAL_MS;
      return items.find(c => c.status === 'ARRIVED' &&
        new Date(c.updated_at || c.created_at).getTime() > cutoff) || null;
    },

    get(caseCode) { return items.find(c => c.case_code === caseCode) || null; },

    record(entry) {
      const existing = items.find(c => c.case_code === entry.case_code);
      if (existing) { Object.assign(existing, entry, { updated_at: new Date().toISOString() }); }
      else {
        items.unshift(Object.assign({
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: 'PENDING',
        }, entry));
        items = items.slice(0, MAX_KEPT);
      }
      persist();
      return this.get(entry.case_code);
    },

    setStatus(caseCode, status, extra) {
      const c = this.get(caseCode);
      if (!c) return null;
      c.status = status;
      c.updated_at = new Date().toISOString();
      if (extra) Object.assign(c, extra);
      persist();
      return c;
    },

    clear() { items = []; persist(); },
  };
}

export const STATUS_TEXT = {
  PENDING:  'Waiting for a hospital',
  ACCEPTED: 'Accepted — en route',
  ARRIVED:  'Arrived',
  EXPIRED:  'No hospital accepted',
  REJECTED: 'Declined by all',
  CANCELLED:'Cancelled',
  QUEUED:   'Queued — no signal',
};

export const STATUS_TONE = {
  PENDING: 'caution', ACCEPTED: 'good', ARRIVED: 'good',
  EXPIRED: 'critical', REJECTED: 'critical', CANCELLED: 'muted', QUEUED: 'caution',
};

export function describeWhen(iso, now) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.floor(((now || Date.now()) - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 min ago';
  if (mins < 60) return mins + ' min ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : hours + ' hours ago';
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : days + ' days ago';
}
