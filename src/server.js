'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { exportWorkbookBuffer } = require('./migration');
const { kstToday } = require('./utils');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function getLanIpv4Addresses() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const list of Object.values(ifaces)) {
    for (const info of list || []) {
      if (info && info.family === 'IPv4' && !info.internal && info.address) {
        ips.push(info.address);
      }
    }
  }
  return [...new Set(ips)];
}

function readJsonBody(req, maxBytes = 68 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('요청 데이터 크기가 허용 한도를 초과했습니다.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(new Error('잘못된 JSON 요청 형식입니다.'));
      }
    });
    req.on('error', reject);
  });
}

class LocalHttpServer {
  constructor(service, db, options = {}) {
    this.service = service;
    this.db = db;
    this.publicDir = options.publicDir || path.join(__dirname, '..', 'public');
    this.preferredPort = options.port || 3840;
    this.host = options.lanEnabled ? '0.0.0.0' : '127.0.0.1';
    this.port = this.preferredPort;
    this.server = null;
    this.sockets = new Set();
  }

  getRuntimeInfo() {
    const lanIps = getLanIpv4Addresses();
    const lanEnabled = this.host === '0.0.0.0';
    return {
      서버포트: this.port,
      로컬주소: `http://127.0.0.1:${this.port}`,
      원내접속주소목록: lanEnabled ? lanIps.map((ip) => `http://${ip}:${this.port}`) : [],
      원내IP목록: lanIps,
    };
  }

  async handleRequest(req, res) {
    const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
    const pathname = reqUrl.pathname;

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'GET' && pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/rpc') {
      if (req.headers['x-local-app'] !== '1') {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, message: '허용되지 않은 요청입니다.' }));
        return;
      }
      try {
        const body = await readJsonBody(req);
        const result = await this.service.dispatch(body.method, body.arg);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/export-xlsx') {
      if (req.headers['x-local-app'] !== '1') {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, message: '허용되지 않은 요청입니다.' }));
        return;
      }
      try {
        const body = await readJsonBody(req, 1024 * 1024);
        if (!this.service.verifyAdminToken(body.토큰)) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, message: '관리자 로그인이 필요합니다' }));
          return;
        }
        const buffer = exportWorkbookBuffer(this.db);
        const fileName = `원탑통증재활센터_백업_${kstToday()}.xlsx`;
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="backup.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'Content-Length': buffer.length,
        });
        res.end(buffer);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, message: '엑셀 내보내기 실패: ' + err.message }));
      }
      return;
    }

    if (req.method === 'GET') {
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const resolved = path.resolve(this.publicDir, rel);
      const rootWithSep = path.resolve(this.publicDir) + path.sep;
      if (resolved !== path.resolve(this.publicDir) && !resolved.startsWith(rootWithSep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        const ext = path.extname(resolved).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        fs.createReadStream(resolved).pipe(res);
        return;
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }

  listenOn(host, port) {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: err.message }));
          }
        });
      });
      srv.on('connection', (sock) => {
        this.sockets.add(sock);
        sock.on('close', () => this.sockets.delete(sock));
      });
      srv.once('error', reject);
      srv.listen(port, host, () => {
        const addr = srv.address();
        this.server = srv;
        this.host = host;
        this.port = addr && typeof addr === 'object' ? addr.port : port;
        resolve(this.port);
      });
    });
  }

  async start() {
    try {
      await this.listenOn(this.host, this.preferredPort);
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        await this.listenOn(this.host, 0);
      } else {
        throw err;
      }
    }
    return this.port;
  }

  async stop() {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    for (const sock of this.sockets) {
      try { sock.destroy(); } catch (_) {}
    }
    this.sockets.clear();
    await new Promise((resolve) => srv.close(() => resolve()));
  }

  async reconfigure({ lanEnabled }) {
    const targetHost = lanEnabled ? '0.0.0.0' : '127.0.0.1';
    if (this.server && this.host === targetHost) return this.port;
    const prevPort = this.port || this.preferredPort;
    await this.stop();
    this.host = targetHost;
    this.preferredPort = prevPort;
    return this.start();
  }
}

module.exports = { LocalHttpServer, getLanIpv4Addresses };
