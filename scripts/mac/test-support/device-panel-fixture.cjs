// Ephemeral loopback server for the Swift device directory client contract.
const http = require('node:http');
const fs = require('node:fs');
const [portFile, mode, token] = process.argv.slice(2);

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401); res.end(JSON.stringify({ error: 'unauthorized' })); return;
  }
  if (mode === 'legacy') {
    res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return;
  }
  if (req.method === 'GET' && req.url === '/_codassol/devices') {
    res.writeHead(200); res.end(JSON.stringify({
      version: 1, localDeviceId: 'mac-id', devices: [
        { id: 'win-id', installationId: 'stable-windows-uuid', name: 'GPU PC',
          platform: 'win32', kind: 'router', isThisDevice: false, status: 'offline',
          online: false, backendReachable: false, lastSeenAt: 0 },
        { id: 'mac-id', installationId: 'stable-mac-uuid', name: 'My Mac',
          platform: 'darwin', kind: 'router', isThisDevice: true, status: 'online',
          online: true, backendReachable: true, lastSeenAt: Date.now() }
      ]
    })); return;
  }
  if (req.method === 'PATCH' && req.url === '/_codassol/devices/win-id') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const data = JSON.parse(Buffer.concat(chunks).toString());
      if (data.name !== 'Home GPU') { res.writeHead(400); res.end('{}'); return; }
      res.writeHead(200); res.end(JSON.stringify({ok: true, device: {id: 'win-id', name: data.name}, sync: { attempted: 2, delivered: 1 }}));
    }); return;
  }
  res.writeHead(404); res.end('{}');
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)));
