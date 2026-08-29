// Qualification harness for the uncapped-rendering WebSocket starvation fix.
// Run this file with the Electron binary under test, not with system Node:
//   electron script/uncapped-websocket-starvation/cdp-test.js 8085 LABEL 12000

const { app, BrowserWindow } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const appArgs = process.argv.slice(1).filter((argument) => !argument.startsWith('-'));
const port = Number.parseInt(appArgs[1] || '8085', 10);
const label = appArgs[2] || 'TEST';
const durationMs = Number.parseInt(appArgs[3] || '12000', 10);
const maxOver50 = Number.parseInt(process.env.WS_STARVATION_MAX_OVER_50 || '0', 10);
const warmupMs = 3000;

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
if (!Number.isInteger(durationMs) || durationMs < 1000) throw new Error(`Invalid duration: ${durationMs}`);
if (!Number.isInteger(maxOver50) || maxOver50 < 0) throw new Error(`Invalid WS_STARVATION_MAX_OVER_50: ${maxOver50}`);

// These are intentionally the production WOK uncapped switches. The test must
// exercise the same Chromium scheduling path as the affected client.
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-gpu-vsync');

const stressPage = fs.readFileSync(path.join(__dirname, 'stress.html'));
const sockets = new Set();
let messageSequence = 0;

function websocketTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function attachWebSocketServer(server) {
  server.on('upgrade', (request, socket) => {
    if (request.url !== '/ws') {
      socket.destroy();
      return;
    }

    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    sockets.add(socket);
    const remove = () => sockets.delete(socket);
    socket.on('close', remove);
    socket.on('end', remove);
    socket.on('error', remove);
  });
}

const server = http.createServer((request, response) => {
  if (request.url !== '/' && request.url !== '/stress.html') {
    response.writeHead(404);
    response.end('not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(stressPage);
});
attachWebSocketServer(server);

const broadcastTimer = setInterval(() => {
  const frame = websocketTextFrame(JSON.stringify({ sequence: messageSequence++, sentAt: Date.now() }));
  for (const socket of sockets) {
    if (socket.destroyed) {
      sockets.delete(socket);
      continue;
    }
    socket.write(frame);
  }
}, 16);

function closeServer() {
  clearInterval(broadcastTimer);
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  return new Promise((resolve) => server.close(() => resolve()));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatMetric(metric) {
  return `p50=${metric.p50.toFixed(1)}ms p95=${metric.p95.toFixed(1)}ms ` +
    `p99=${metric.p99.toFixed(1)}ms max=${metric.max.toFixed(1)}ms ` +
    `>50ms=${metric.over50}/${metric.total}`;
}

async function run() {
  let window;
  let debuggerAttached = false;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    console.log(`[${label}] Server listening on 127.0.0.1:${port}`);

    await app.whenReady();
    window = new BrowserWindow({
      width: 1280,
      height: 800,
      show: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    await window.loadURL(`http://127.0.0.1:${port}/`);

    const webContents = window.webContents;
    webContents.debugger.attach('1.3');
    debuggerAttached = true;
    await sleep(warmupMs);
    await webContents.executeJavaScript('window.resetStressMetrics()', true);

    console.log(`[${label}] Starting ${durationMs / 1000}s CDP mouse stress test`);
    const startTime = Date.now();
    const centerX = 640;
    const centerY = 400;
    let angle = 0;
    let eventCount = 0;

    await webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: centerX,
      y: centerY,
      button: 'left',
      buttons: 1,
      clickCount: 1
    });

    while (Date.now() - startTime < durationMs) {
      const batch = [];
      for (let index = 0; index < 10; index++) {
        angle += 0.03;
        const radius = 150 + Math.sin(angle * 0.5) * 70;
        const x = Math.floor(centerX + Math.cos(angle) * radius);
        const y = Math.floor(centerY + Math.sin(angle) * radius);
        batch.push(
          webContents.debugger
            .sendCommand('Input.dispatchMouseEvent', {
              type: 'mouseMoved',
              x,
              y,
              button: 'left',
              buttons: 1
            })
            .catch(() => undefined)
        );
        eventCount++;
      }
      await Promise.all(batch);
    }

    await webContents.debugger
      .sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: centerX,
        y: centerY,
        button: 'left',
        buttons: 0
      })
      .catch(() => undefined);

    await sleep(250);
    const resultText = await webContents.executeJavaScript(
      'window.setStressActive(false); window.getStressMetrics()',
      true
    );
    const result = JSON.parse(resultText);

    if (debuggerAttached) {
      webContents.debugger.detach();
      debuggerAttached = false;
    }

    console.log(`[${label}] CDP mouse events sent: ${eventCount}`);
    console.log(`[${label}] Renderer mouse events: ${result.mouseEvents}`);
    console.log(`[${label}] Rendered frames: ${result.frames}`);
    console.log(`[${label}] FPS: ${result.fps.toFixed(1)}`);
    console.log(`[${label}] Frame-time p95: ${result.frameTimeP95.toFixed(1)}ms`);
    console.log(`[${label}] WebSocket: ${formatMetric(result.websocket)}`);
    console.log(`[${label}] Worker: ${formatMetric(result.worker)}`);
    console.log(`[${label}] WebSocket messages >50ms: ${result.websocket.over50Percent.toFixed(2)}%`);
    console.log(`[${label}] Worker messages >50ms: ${result.worker.over50Percent.toFixed(2)}%`);

    const passed =
      result.websocket.total > 0 &&
      result.worker.total > 0 &&
      result.mouseEvents > 0 &&
      result.frames > 0 &&
      result.websocket.over50 <= maxOver50 &&
      result.worker.over50 <= maxOver50;
    if (!passed) {
      throw new Error(
        `qualification failed: WebSocket/Worker >50ms must be <= ${maxOver50} message(s)`
      );
    }
    console.log(`[${label}] PASS: no callback latency exceeded the configured 50ms threshold`);
  } finally {
    if (window) {
      if (debuggerAttached) {
        try {
          window.webContents.debugger.detach();
        } catch (_error) {
          // The renderer may already have exited after a failed qualification.
        }
      }
      window.close();
    }
    await closeServer();
    if (app.isReady()) app.quit();
  }
}

run().catch((error) => {
  console.error(`[${label}] FAIL: ${error.stack || error.message}`);
  process.exitCode = 1;
});
