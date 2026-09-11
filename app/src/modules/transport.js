/* ============================================================================
   Talking to the backend — and a demo transport that behaves exactly like it.

   Demo mode is not a mock bolted on for tests. It is the mode the APK falls
   into when nobody configured a server, and the mode a judge sees when the
   venue Wi-Fi dies. It therefore walks the same state machine as the real
   thing: pending → accepted, with a hospital that has a name, a distance and
   a phone number. Nothing about the UI knows which transport it is on.
   ========================================================================== */

const DEMO_HOSPITALS_NOTIFIED = 3;

export const DEMO_ACCEPTOR = {
  hospital_id: 1,
  name: 'Demo City ER',
  distance_km: 3.4,
  phone: '+911234567890',
  lat: 12.9899,
  lng: 77.5921,
};

export class NetworkError extends Error {
  constructor(message) { super(message || 'Network unreachable'); this.name = 'NetworkError'; this.network = true; }
}
export class RejectedError extends Error {
  constructor(message, status) { super(message || 'Rejected'); this.name = 'RejectedError'; this.status = status; }
}

/* ── Live ──────────────────────────────────────────────────────────────── */

export function createLiveTransport(apiRoot, fetchImpl) {
  const doFetch = fetchImpl;
  const url = path => apiRoot.replace(/\/+$/, '') + path;

  async function readJson(res) {
    try { return await res.json(); } catch (_) { return null; }
  }

  return {
    kind: 'live',

    async caseTypes() {
      const res = await doFetch(url('/case-types'));
      if (!res.ok) throw new RejectedError('HTTP ' + res.status, res.status);
      return await res.json();
    },

    async broadcast(payload, clientRequestId) {
      let res;
      try {
        res = await doFetch(url('/requests'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client-Request-Id': clientRequestId },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        throw new NetworkError(err && err.message);
      }
      if (res.status >= 500) throw new NetworkError('Server error ' + res.status);
      const body = await readJson(res);
      if (!res.ok) throw new RejectedError((body && body.message) || ('HTTP ' + res.status), res.status);
      return body;
    },

    async status(caseCode) {
      let res;
      try { res = await doFetch(url('/requests/' + encodeURIComponent(caseCode))); }
      catch (err) { throw new NetworkError(err && err.message); }
      if (!res.ok) throw new RejectedError('HTTP ' + res.status, res.status);
      return await res.json();
    },
  };
}

/* ── Demo ──────────────────────────────────────────────────────────────── */

export function createDemoTransport(options) {
  const opts = options || {};
  const delay = () => Number(opts.postMs && opts.postMs()) || 300;
  const shouldFail = () => !!(opts.shouldFail && opts.shouldFail());
  const wait = ms => new Promise(r => setTimeout(r, ms));

  let counter = 0;
  const cases = new Map();

  return {
    kind: 'demo',

    async caseTypes() { return opts.caseTypes || []; },

    async broadcast(payload) {
      await wait(delay());
      if (shouldFail()) throw new NetworkError('Demo mode: simulated send failure');
      counter += 1;
      const id = 'GH-DEMO-' + String(counter).padStart(4, '0');
      const now = Date.now();
      cases.set(id, { id, created: now, payload });
      return {
        id,
        status: 'PENDING',
        hospitals_notified: DEMO_HOSPITALS_NOTIFIED,
        expires_at: new Date(now + 180000).toISOString(),
        priority: 'RED',
      };
    },

    async status(caseCode) {
      const entry = cases.get(caseCode);
      if (!entry) throw new RejectedError('Unknown case', 404);
      /* A demo hospital accepts shortly after the broadcast, the same way a
         real desk does. The delay is short enough to demo, long enough that
         the pending state is actually visible. */
      const accepted = (Date.now() - entry.created) >= Math.max(20, delay() * 4);
      if (!accepted) {
        return { id: caseCode, status: 'PENDING', hospitals_notified: DEMO_HOSPITALS_NOTIFIED, priority: 'RED' };
      }
      return {
        id: caseCode,
        status: 'ACCEPTED',
        priority: 'RED',
        hospitals_notified: DEMO_HOSPITALS_NOTIFIED,
        accepted_by: DEMO_ACCEPTOR.name,
        accepted_hospital: Object.assign({}, DEMO_ACCEPTOR),
      };
    },
  };
}
