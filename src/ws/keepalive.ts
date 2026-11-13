import type { WebSocket } from 'ws';

/**
 * Pings the peer every `interval` ms and terminates the socket when nothing
 * (message or pong) has been received for `timeout` ms. Returns a stop function.
 */
export function keepalive(
  socket: WebSocket,
  { interval, timeout }: { interval: number; timeout: number },
) {
  if (timeout <= 0) return () => {};
  let lastSeen = Date.now();
  const seen = () => (lastSeen = Date.now());
  socket.on('message', seen);
  socket.on('pong', seen);
  socket.on('ping', seen);

  const tick = interval > 0 ? Math.min(interval, timeout) : timeout;
  const timer = setInterval(() => {
    if (Date.now() - lastSeen >= timeout) return socket.terminate();
    if (interval > 0) socket.ping();
  }, tick);
  timer.unref();

  const stop = () => {
    clearInterval(timer);
    socket.off('message', seen);
    socket.off('pong', seen);
    socket.off('ping', seen);
  };
  socket.once('close', stop);
  return stop;
}
