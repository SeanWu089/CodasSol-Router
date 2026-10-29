import net from 'node:net';
// An OS-owned socket releases automatically on crash; no stale PID lock deletion.
export async function acquireInstance(port, host = '127.0.0.1') {
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port, exclusive: true }, resolve);
  });
  return server;
}
export function backendReady(value, service) {
  return value?.ok === true && (service === 'devspace'
    ? value.name === 'devspace' : value.backendReachable === true);
}
