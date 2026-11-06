// Live updates over server-sent events. Each open browser tab holds one stream.
const streams = new Map();
const HEARTBEAT_MS = 25 * 1000;

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function openStream(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');

  const userId = req.user.id;
  if (!streams.has(userId)) streams.set(userId, new Set());
  streams.get(userId).add(res);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    const set = streams.get(userId);
    set?.delete(res);
    if (set?.size === 0) streams.delete(userId);
  });
}

export function pushToUser(userId, event, data) {
  const set = streams.get(String(userId));
  if (!set) return;
  for (const res of set) send(res, event, data);
}

export function pushToEveryone(event, data) {
  for (const set of streams.values()) {
    for (const res of set) send(res, event, data);
  }
}

export function closeAllStreams() {
  for (const set of streams.values()) {
    for (const res of set) res.end();
  }
  streams.clear();
}
