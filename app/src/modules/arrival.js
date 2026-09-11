/* A timeout or HTTP error must never turn into a local success. */
export async function recordArrival({ socket, fetch: fetcher, apiRoot, caseCode, timeoutMs = 5000 }) {
  if (socket && socket.connected) {
    const ack = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      socket.emit('ambulance:arrived', { case_code: caseCode }, body => { clearTimeout(timer); resolve(body); });
    });
    if (ack && ack.success === true) return ack;
    if (ack && ack.success === false) throw new Error(ack.message || 'Arrival was refused');
    // Lost ACK: the same idempotent operation can safely be retried over HTTP.
  }
  if (!apiRoot || typeof fetcher !== 'function') throw new Error('No connection to the server');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(apiRoot + '/requests/' + encodeURIComponent(caseCode) + '/arrived', { method: 'POST', signal: controller.signal });
    const body = await response.json();
    if (!response.ok || !body || body.success !== true || body.status !== 'ARRIVED') throw new Error((body && body.message) || 'Arrival was refused');
    return body;
  } finally { clearTimeout(timer); }
}
