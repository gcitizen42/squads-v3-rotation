import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { ROOT, OLD, load, verifyPlan, next, OWNERS } from './sandbox.mjs';
import { overview, prepareDesired, nextDesired, desiredRecord } from './desired.mjs';

const port = Number(process.env.PORT || 8774);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid port');
const origin = `http://127.0.0.1:${port}`;
const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/receipt-check.js': ['receipt-check.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://solana-rpc.publicnode.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  try {
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403); return res.end('Local same-origin access only'); }
    const url = new URL(req.url, origin);
    if (req.method === 'POST' && url.pathname === '/api/desired/prepare') {
      if (req.headers.origin !== origin || req.headers['content-type']?.split(';')[0] !== 'application/json') { res.writeHead(403); return res.end('Same-origin JSON required'); }
      let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16384) { res.writeHead(413); return res.end('Request too large'); } }
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(await prepareDesired(JSON.parse(raw))));
    }
    if (req.method !== 'GET') { res.writeHead(405); return res.end('No transaction broadcasts; only local preparation is supported'); }
    if (url.pathname === '/api/plan') {
      const plan = await load('outputs/plan.json'); verifyPlan(plan);
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ uiVersion: 'custom-rotation-7', plan, rehearsal: await load('outputs/rehearsal.json') }));
    }
    if (url.pathname === '/api/next') {
      const owner = url.searchParams.get('owner');
      if (!OWNERS.includes(owner)) { res.writeHead(400); return res.end('Unknown test owner'); }
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(await next(owner)));
    }
    if (url.pathname === '/api/management') {
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(await overview(url.searchParams.get('owner'), undefined, url.searchParams.get('multisig') || undefined)));
    }
    if (url.pathname === '/api/desired/next') {
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(await nextDesired(url.searchParams.get('id'), url.searchParams.get('owner'))));
    }
    if (url.pathname === '/api/desired/plan') {
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(await desiredRecord(url.searchParams.get('id'))));
    }
    if (url.pathname === '/web3.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      return res.end(await readFile(new URL('node_modules/@solana/web3.js/lib/index.iife.min.js', ROOT)));
    }
    if (files[url.pathname]) {
      const [file, type] = files[url.pathname]; res.setHeader('Content-Type', type); return res.end(await readFile(new URL(file, ROOT)));
    }
    res.writeHead(404); res.end('Not found');
  } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
});
server.listen(port, '127.0.0.1', () => console.log(`Squads v3 rotation: ${origin}/?v=custom-rotation-7#management\nBackend prepares public local plans only. Only your browser wallet can sign/submit after explicit confirmation.`));
