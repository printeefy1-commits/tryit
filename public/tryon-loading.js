export function aborted() {
  return new DOMException('Opération annulée.', 'AbortError');
}

export function waitFor(promise, milliseconds, message, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      callback(value);
    };
    const cancel = () => finish(reject, aborted());
    const timer = setTimeout(() => finish(reject, new Error(message)), milliseconds);
    signal?.addEventListener('abort', cancel, {once: true});
    // Attach both handlers even if already cancelled, so late failures are observed.
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal?.aborted) cancel();
  });
}

// Bound inactivity, rather than total transfer time: slow downloads may progress
// for longer than 30 seconds without being mistaken for a stalled connection.
export async function fetchBuffer(url, {signal, label = 'Fichier', onProgress, maxBytes = 25 * 1024 * 1024, inactivityMs = 30000} = {}) {
  const controller = new AbortController();
  let timer, timedOut = false;
  const cancel = () => controller.abort();
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {timedOut = true; controller.abort();}, inactivityMs);
  };
  signal?.addEventListener('abort', cancel, {once: true});
  if (signal?.aborted) controller.abort();
  arm();
  try {
    const response = await fetch(url, {signal: controller.signal});
    if (!response.ok) throw new Error(`${label} indisponible sur le serveur (HTTP ${response.status}).`);
    const total = Number(response.headers.get('x-model-bytes') || response.headers.get('content-length')) || 0;
    if (total > maxBytes) throw new Error(`${label} trop volumineux (${Math.round(maxBytes/1024/1024)} Mo maximum).`);
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      arm();
      const {done, value} = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new Error(`${label} trop volumineux (${Math.round(maxBytes/1024/1024)} Mo maximum).`);
      chunks.push(value);
      onProgress?.(received, total);
    }
    const buffer = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {buffer.set(chunk, offset); offset += chunk.byteLength;}
    return buffer.buffer;
  } catch (error) {
    if (timedOut) throw new Error(`${label} : le téléchargement ne répond plus. Vérifiez votre connexion puis réessayez.`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
}

export function transferMessage(label, received, total) {
  const size = (received / (1024 * 1024)).toFixed(1);
  return total > 0
    ? `${label} : ${Math.min(100, Math.round(received / total * 100))} % (${size} Mo)…`
    : `${label} : ${size} Mo…`;
}
