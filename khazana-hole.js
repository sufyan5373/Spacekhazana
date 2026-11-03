// KHAZANA HOLE — single file, zero npm deps.
//   • Inside SpaceKhazana (recommended):   const mountHole = require('./khazana-hole'); mountHole(app, requireAuth);
//       -> adds  /api/hole/start | status | file | cancel | search   (the Music section uses these)
//   • Standalone:  node khazana-hole.js  ->  http://localhost:3000   (original drop-a-link page)
// Auto-fetches yt-dlp on first run (YouTube, Instagram, TikTok, X, Facebook, Reddit, 1000+ sites).
// ffmpeg is auto-fetched on Windows (needed for 4K merge + mp3). Instagram/private stuff: set BH_COOKIES_BROWSER=firefox (or chrome, edge).
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const dns = require('dns').promises, crypto = require('crypto');
const { spawn, spawnSync } = require('child_process'), { Readable } = require('stream'), { pipeline } = require('stream/promises');
const MAXB = 600 * 1024 * 1024;   // refuse anything bigger than 600 MB
const PORT = process.env.PORT || 3000, COOKIES = process.env.BH_COOKIES_BROWSER || '', WIN = process.platform === 'win32';
const have = (c, a) => { try { return spawnSync(c, a).status === 0 } catch { return false } };
let FFMPEG = have('ffmpeg', ['-version']), FFLOC = '';

let YT = null;
const ready = (async () => {
  if (have('yt-dlp', ['--version'])) { YT = 'yt-dlp'; return; }
  const f = path.join(__dirname, WIN ? 'yt-dlp.exe' : 'yt-dlp');
  if (!fs.existsSync(f) || Date.now() - fs.statSync(f).mtimeMs > 7 * 864e5) { // refresh weekly (sites break often)
    try {
      console.log('Fetching yt-dlp…');
      const asset = WIN ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
      const r = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/' + asset);
      if (!r.ok) throw Error('HTTP ' + r.status);
      fs.writeFileSync(f + '.tmp', Buffer.from(await r.arrayBuffer())); fs.chmodSync(f + '.tmp', 0o755); fs.renameSync(f + '.tmp', f);
    } catch (e) { console.log('yt-dlp download failed:', e.message); }
  }
  if (fs.existsSync(f)) YT = f;
  const ff = path.join(__dirname, 'ffmpeg.exe');
  if (!FFMPEG && WIN) {
    try {
      if (!fs.existsSync(ff)) {
        console.log('Fetching ffmpeg (one time, ~130 MB, needed for 4K)…');
        const z = path.join(__dirname, 'ffmpeg.zip'), tmp = path.join(__dirname, 'ffmpeg-tmp');
        const r = await fetch('https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip');
        if (!r.ok) throw Error('HTTP ' + r.status);
        await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(z));
        fs.mkdirSync(tmp, { recursive: true });
        if (spawnSync('tar', ['-xf', z, '-C', tmp]).status !== 0) throw Error('unzip failed');
        const find = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { const x = find(p); if (x) return x; } else if (e.name === 'ffmpeg.exe') return p; } };
        fs.copyFileSync(find(tmp), ff);
        fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(z, { force: true });
      }
      FFMPEG = true; FFLOC = __dirname;
    } catch (e) { console.log('ffmpeg setup failed (' + e.message + '). Run: winget install ffmpeg, then restart.'); }
  }
  console.log('yt-dlp:', YT || 'unavailable (direct links only)', '| ffmpeg:', FFMPEG ? 'yes' : 'no');
})();

// ---------- safety: block localhost / LAN targets ----------
function priv(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase(); if (l.startsWith('::ffff:')) return priv(l.slice(7));
  return l === '::1' || l === '::' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
}
async function safe(u) {
  const x = new URL(u);
  if (!/^https?:$/.test(x.protocol)) throw Error('Only http(s) links');
  const a = await dns.lookup(x.hostname, { all: true });
  if (!a.length || a.some(i => priv(i.address))) throw Error('Blocked address');
  return x;
}
async function open(u) {
  for (let i = 0; i < 6; i++) {
    const x = await safe(u);
    const r = await fetch(x, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 BlackHole' } });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) { r.body && r.body.cancel(); u = new URL(loc, x).href; continue; }
    return { r, url: u };
  }
  throw Error('Too many redirects');
}
const isHtml = r => (r.headers.get('content-type') || '').includes('text/html');
const EXT = { 'text/html': '.html', 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3', 'application/zip': '.zip', 'application/json': '.json', 'text/plain': '.txt' };
function fname(r, u) {
  const cd = r.headers.get('content-disposition') || '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
  let n = ''; try { n = decodeURIComponent(m ? m[1] : new URL(u).pathname.split('/').pop() || ''); } catch { }
  n = n.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  if (!n || /^\.+$/.test(n)) n = 'blackhole-' + Date.now();
  if (!path.extname(n)) n += EXT[(r.headers.get('content-type') || '').split(';')[0]] || (isHtml(r) ? '.html' : '');
  return n;
}

// ---------- jobs ----------
const jobs = new Map();
const drop = id => { const j = jobs.get(id); if (j) { fs.rm(j.dir, { recursive: true, force: true }, () => { }); jobs.delete(id); } };

async function direct(job, r, url) {
  const name = fname(r, url), total = +r.headers.get('content-length') || 0, enc = r.headers.get('content-encoding');
  if (total > MAXB) throw Error('File is too large');
  let got = 0; const rs = Readable.fromWeb(r.body);
  rs.on('data', d => { got += d.length; if (got > MAXB) rs.destroy(Error('File is too large')); if (total && !enc) job.pct = got / total * 100; });
  await pipeline(rs, fs.createWriteStream(path.join(job.dir, name)));
  job.name = name; job.file = path.join(job.dir, name);
}
function ytdlp(job, url) {
  return new Promise((res, rej) => {
    const a = ['--no-playlist', '--newline', '--no-warnings', '--windows-filenames', '--progress-template', 'download:PCT %(progress._percent_str)s',
      '--max-filesize', '600M', '--socket-timeout', '30', '-o', path.join(job.dir, '%(title).80B.%(ext)s')];
    if (FFLOC) a.push('--ffmpeg-location', FFLOC);
    const H = +job.q || 2160;
    if (job.mode === 'image') { /* default format: photo posts */ }
    else if (job.mode === 'audio') a.push(...(FFMPEG ? ['-x', '--audio-format', 'mp3', '--audio-quality', '0', '--embed-metadata'] : ['-f', 'ba/b']));
    else if (FFMPEG) a.push('-f', 'bv*[height<=' + H + ']+ba/b[height<=' + H + ']/bv*+ba/b', '-S', H > 1080 ? 'res,vcodec:vp9,acodec:m4a' : 'vcodec:h264,res,acodec:m4a', '--merge-output-format', 'mp4');
    else a.push('-f', 'b/best');
    if (COOKIES) a.push('--cookies-from-browser', COOKIES);
    a.push(url);
    const p = spawn(YT, a); let err = '', buf = '';
    p.stdout.on('data', d => { buf += d; let m; while ((m = /PCT\s+([\d.]+)%/g.exec(buf))) { job.pct = +m[1]; buf = buf.slice(m.index + m[0].length); } });
    p.stderr.on('data', d => err += d);
    p.on('error', e => rej(e));
    p.on('close', code => {
      const fl = fs.readdirSync(job.dir).filter(f => !/\.(part|ytdl|temp)$/.test(f)).map(f => ({ f, s: fs.statSync(path.join(job.dir, f)).size })).sort((x, y) => y.s - x.s);
      if (code === 0 && fl.length) { job.name = fl[0].f; job.file = path.join(job.dir, fl[0].f); res(); }
      else rej(Error((err.split('\n').filter(l => /ERROR/.test(l)).pop() || 'yt-dlp failed').replace(/^ERROR:\s*/, '').slice(0, 200)));
    });
    job.kill = () => p.kill();
  });
}
async function run(job) {
  try {
    await ready; await safe(job.url);
    let r = null, url = job.url;
    try { ({ r, url } = await open(job.url)); } catch (e) { if (/^(Blocked|Only)/.test(e.message) || !YT) throw e; }
    if (r && r.ok && !isHtml(r)) return await direct(job, r, url);
    r && r.body && r.body.cancel();
    const page = async () => { const o = await open(url); await direct(job, o.r, o.url); };
    if (job.mode === 'image') {
      const og = async () => {
        const o = await open(url), h = await o.r.text();
        const m = /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*content=["']([^"']+)/i.exec(h) || /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i.exec(h);
        if (!m) throw Error('No image found on that page');
        const i = await open(new URL(m[1].replace(/&amp;/g, '&'), o.url).href);
        if (!i.r.ok) throw Error('Image returned ' + i.r.status);
        await direct(job, i.r, i.url);
      };
      if (YT && !/(^|\.)(youtube\.com|youtu\.be)$/i.test(new URL(url).hostname)) { try { return await ytdlp(job, url); } catch { } }
      return await og();
    }
    if (YT) { try { await ytdlp(job, url); } catch (e) { if (r && r.ok) await page(); else throw e; } }
    else if (r && r.ok) await page();
    else throw Error('Source returned ' + (r ? r.status : 'an error'));
  } catch (e) { job.error = e.message; }
  finally { job.done = true; }
}

// ---------- http ----------
const j = (res, c, o) => { res.writeHead(c, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
const MAX_PER_OWNER = 2, MAX_TOTAL = 4;
const activeFor = owner => [...jobs.values()].filter(x => !x.done && x.owner === owner).length;
const activeAll = () => [...jobs.values()].filter(x => !x.done).length;

// ---- YouTube search (yt-dlp, no API key) ----
const searchCache = new Map(), lastSearch = new Map();
function ytSearch(query) {
  const key = query.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.t < 10 * 60e3) return Promise.resolve(hit.items);
  return new Promise((resolve, reject) => {
    const p = spawn(YT, ['ytsearch12:' + query, '--flat-playlist', '--dump-json', '--no-warnings', '--skip-download', '--socket-timeout', '15']);
    let out = '', err = '';
    const timer = setTimeout(() => p.kill(), 30000);
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', () => {
      clearTimeout(timer);
      const items = [];
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (!o.id || String(o.id).length !== 11) continue;
          items.push({ id: o.id, title: o.title || '', channel: o.channel || o.uploader || '', duration: Math.round(o.duration || 0) });
        } catch { }
      }
      if (!items.length) return reject(Error((err.split('\n').filter(l => /ERROR/.test(l)).pop() || 'No results').replace(/^ERROR:\s*/, '').slice(0, 160)));
      searchCache.set(key, { t: Date.now(), items });
      if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
      resolve(items);
    });
  });
}

// route = '/start' | '/status' | '/file' | '/cancel' | '/search' | '/health'
async function api(route, q, req, res, owner) {
  if (route === '/health') return j(res, 200, { ok: true, ytdlp: !!YT, ffmpeg: !!FFMPEG });
  if (route === '/search') {
    const text = (q.get('q') || '').trim().slice(0, 120);
    if (!text) return j(res, 400, { error: 'Type something to search' });
    const now = Date.now();
    if (now - (lastSearch.get(owner) || 0) < 500) return j(res, 429, { error: 'Slow down a little' });
    lastSearch.set(owner, now); if (lastSearch.size > 500) lastSearch.delete(lastSearch.keys().next().value);
    await ready;
    if (!YT) return j(res, 503, { error: 'yt-dlp is not available on the server' });
    try { return j(res, 200, { items: await ytSearch(text) }); }
    catch (e) { return j(res, 502, { error: e.message || 'Search failed' }); }
  }
  if (route === '/start') {
    let link = (q.get('url') || '').trim(); if (!link) return j(res, 400, { error: 'No link' });
    if (!/^[a-z]+:\/\//i.test(link)) link = 'https://' + link;
    if (activeFor(owner) >= MAX_PER_OWNER) return j(res, 429, { error: 'You already have ' + MAX_PER_OWNER + ' downloads running — wait for one to finish.' });
    if (activeAll() >= MAX_TOTAL) return j(res, 429, { error: 'The server is busy right now — try again in a minute.' });
    const id = crypto.randomBytes(8).toString('hex');
    const job = { url: link, owner, mode: ['audio', 'image'].includes(q.get('mode')) ? q.get('mode') : 'video', q: q.get('q') || '2160', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'bh-')), pct: 0, done: false };
    jobs.set(id, job); setTimeout(() => { job.kill && job.kill(); drop(id); }, 30 * 60e3); run(job);
    return j(res, 200, { id });
  }
  const job = jobs.get(q.get('id'));
  const mine = job && job.owner === owner;
  if (route === '/status') {
    if (!mine) return j(res, 404, { error: 'Expired' });
    return j(res, 200, { done: job.done, pct: Math.round(job.pct || 0), error: job.error, name: job.name });
  }
  if (route === '/cancel') {
    if (mine) { job.kill && job.kill(); drop(q.get('id')); }
    return j(res, 200, { ok: true });
  }
  if (route === '/file') {
    if (!mine || !job.file) return j(res, 404, { error: 'Not ready' });
    const st = fs.statSync(job.file);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store', 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(job.name) });
    fs.createReadStream(job.file).pipe(res); res.on('close', () => drop(q.get('id'))); return;
  }
  res.writeHead(404); res.end();
}

// ---- mount inside an Express app (SpaceKhazana) ----
function mount(app, auth) {
  const guard = typeof auth === 'function' ? auth : (req, res, next) => next();
  app.use('/api/hole', guard, (req, res) => {
    const u = new URL(req.url, 'http://x');
    const owner = String((req.user && (req.user.id || req.user.username)) || req.headers['x-auth-token'] || req.ip);
    api(u.pathname, u.searchParams, req, res, owner).catch(e => { if (!res.headersSent) j(res, 500, { error: String((e && e.message) || e) }); else res.end(); });
  });
  console.log('Khazana Hole mounted at /api/hole');
}
module.exports = mount; module.exports.mount = mount;

// ---- standalone mode: node khazana-hole.js ----
if (require.main === module) {
  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
    if (u.pathname.startsWith('/api/')) return api('/' + u.pathname.slice(5), u.searchParams, req, res, req.socket.remoteAddress || 'local')
      .catch(e => { if (!res.headersSent) j(res, 500, { error: String((e && e.message) || e) }); });
    res.writeHead(404); res.end();
  }).listen(PORT, () => console.log('Khazana Hole open → http://localhost:' + PORT));
}

// ---------- page ----------
const PAGE = String.raw`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Khazana Hole</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#03050a;color:#e6ecf5;font-family:Inter,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow-x:hidden}
canvas{position:fixed;inset:0;z-index:0}
body:before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;background:radial-gradient(60% 50% at 50% 30%,#1d4ed826,transparent 70%),radial-gradient(40% 40% at 85% 95%,#0ea5e91c,transparent 70%)}
main{position:relative;z-index:1;min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding:0 16px 5vh}
.brand{text-align:center;margin-bottom:22px}
.brand h1{margin:0;font-weight:200;font-size:clamp(22px,4vw,34px);letter-spacing:.42em;padding-left:.42em;text-transform:uppercase;background:linear-gradient(180deg,#fff,#8fb0ff);-webkit-background-clip:text;background-clip:text;color:transparent}
.brand p{margin:8px 0 0;font-size:11px;letter-spacing:.24em;color:#7d8ba5;text-transform:uppercase}
.glass{width:min(680px,100%);padding:14px;border-radius:26px;background:linear-gradient(145deg,rgba(255,255,255,.09),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.12);box-shadow:0 24px 70px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.14);backdrop-filter:blur(24px) saturate(160%);-webkit-backdrop-filter:blur(24px) saturate(160%)}
form{display:flex;gap:10px}
input{flex:1;min-width:0;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.09);border-radius:16px;color:#fff;font-size:16px;padding:16px 18px;outline:0;transition:.2s}
input:focus{border-color:#3b82f6aa;box-shadow:0 0 0 4px #3b82f622}
input::placeholder{color:#64738c}
.go{border:0;border-radius:16px;padding:0 28px;font-weight:600;font-size:15px;font-family:inherit;color:#fff;cursor:pointer;background:linear-gradient(180deg,#4f94ff,#2563eb);box-shadow:0 8px 24px #2563eb55,inset 0 1px 0 #ffffff55;transition:.2s}
.go:hover{transform:translateY(-1px);box-shadow:0 12px 32px #2563eb88,inset 0 1px 0 #ffffff55}
.go:active{transform:none}
.opts{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
.seg{display:flex;padding:3px;border-radius:12px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.07)}
.seg button{border:0;background:none;color:#8594ae;font-family:inherit;font-weight:500;font-size:13px;padding:7px 16px;border-radius:9px;cursor:pointer;transition:.2s}
.seg button:hover{color:#fff}
.seg button.on{background:linear-gradient(180deg,#4f94ff,#2563eb);color:#fff;box-shadow:0 4px 14px #2563eb55}
#list{max-height:28vh;overflow:auto;scrollbar-width:thin;scrollbar-color:#3b82f655 transparent}
.item{margin-top:10px;padding:12px 14px;border-radius:14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);font-size:13px;color:#a9b6cc;word-break:break-all;animation:in .4s ease}
.item b{color:#e6ecf5;font-weight:500}
.bar{height:3px;border-radius:3px;background:rgba(255,255,255,.08);margin-top:9px;overflow:hidden}
.bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#60a5fa,#3b82f6);transition:width .5s}
.item.ok .bar i{width:100%}
.item.err{border-color:#f8717166}.item.err .bar{display:none}
.hint{margin:14px 0 0;text-align:center;font-size:11px;color:#56647c;letter-spacing:.05em}
@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media(max-width:480px){form{flex-direction:column}.go{padding:15px}}
</style></head><body>
<canvas id="c"></canvas>
<main>
<div class="brand"><h1>Khazana Hole</h1><p>Drop a link. It vanishes. It downloads.</p></div>
<div class="glass">
  <form id="f"><input id="u" placeholder="Paste a link — YouTube, Instagram, TikTok, images, files…" autocomplete="off" autofocus><button class="go">Download</button></form>
  <div class="opts">
    <div class="seg" id="sm"><button data-v="video" class="on">Video</button><button data-v="audio">Audio</button><button data-v="image">Image</button></div>
    <div class="seg" id="sq"><button data-v="2160" class="on">4K</button><button data-v="1440">1440p</button><button data-v="1080">1080p</button><button data-v="720">720p</button></div>
  </div>
  <div id="list"></div>
</div>
<p class="hint">Only download what you have the right to.</p>
</main>
<script>
var c=document.getElementById('c'),x=c.getContext('2d'),W,H,cx,cy,pull=0,fly=[],P=[],mode='video',q='2160';
function size(){W=c.width=innerWidth;H=c.height=innerHeight;cx=W/2;cy=H*.3}
addEventListener('resize',size);size();
function R(){return Math.min(W,H)*.08}
function mk(p){p=p||{};p.a=Math.random()*6.283;p.r=R()*1.4+Math.random()*Math.min(W,H)*.55;p.s=.5+Math.random()*.8;p.h=200+Math.random()*35;p.z=Math.random()*1.5+.4;return p}
for(var i=0;i<650;i++)P.push(mk());
function dot(p,front){
  var px=cx+Math.cos(p.a)*p.r,py=cy+Math.sin(p.a)*p.r*.32;
  if((Math.sin(p.a)>0)!==front)return;
  var near=Math.max(0,1-p.r/(R()*4));
  x.fillStyle='hsl('+p.h+',100%,'+(55+near*40)+'%)';x.globalAlpha=.3+near*.7;x.fillRect(px,py,p.z,p.z);
}
function frame(){
  x.globalAlpha=1;x.fillStyle='rgba(3,5,10,.2)';x.fillRect(0,0,W,H);
  var r0=R(),i;
  for(i=0;i<P.length;i++){var p=P[i];p.a+=p.s*(r0*1.8/p.r)*(.022+pull*.05);p.r-=(.12+pull*2.5)*(1+r0/p.r);if(p.r<r0*.95)mk(p);}
  for(i=0;i<P.length;i++)dot(P[i],false);
  x.globalAlpha=1;x.beginPath();x.arc(cx,cy,r0,0,6.283);x.fillStyle='#000';
  x.shadowColor='#3b82f6';x.shadowBlur=40+pull*80;x.fill();x.shadowBlur=0;
  for(i=0;i<P.length;i++)dot(P[i],true);
  x.globalAlpha=1;x.font='14px monospace';x.textAlign='center';
  for(i=fly.length-1;i>=0;i--){var f=fly[i];f.k+=.018;var e=f.k*f.k;
    var fx=f.x+(cx-f.x)*e+Math.sin(f.k*9)*(1-f.k)*30,fy=f.y+(cy-f.y)*e;
    x.save();x.translate(fx,fy);x.rotate(f.k*8);x.scale(1-f.k*.95,1-f.k*.95);
    x.fillStyle='rgba(170,205,255,'+(1-f.k*.6)+')';x.fillText(f.t,0,0);x.restore();
    if(f.k>=1)fly.splice(i,1);}
  pull*=.965;requestAnimationFrame(frame);
}
frame();
var list=document.getElementById('list'),inp=document.getElementById('u');
function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
function seg(id,cb){var el=document.getElementById(id);el.onclick=function(e){var b=e.target.closest('button');if(!b)return;
  [].forEach.call(el.children,function(k){k.classList.remove('on')});b.classList.add('on');cb(b.dataset.v)}}
seg('sm',function(v){mode=v;document.getElementById('sq').style.display=v=='video'?'flex':'none'});
seg('sq',function(v){q=v});
function set(li,t,p){li.querySelector('b').textContent=t;if(p!=null)li.querySelector('i').style.width=p+'%'}
async function feed(u){
  var short=u.replace(/^https?:\/\//,'').slice(0,46);
  fly.push({t:short,x:W/2,y:H-140,k:0});pull=1;
  var li=document.createElement('div');li.className='item';li.innerHTML='<b></b><div class="bar"><i></i></div>';
  set(li,'Preparing · '+short,3);list.prepend(li);
  try{
    var r=await fetch('/api/start?mode='+mode+'&q='+q+'&url='+encodeURIComponent(u)),j=await r.json();
    if(!r.ok)throw Error(j.error||'Failed');
    for(;;){
      await sleep(800);
      var s=await (await fetch('/api/status?id='+j.id)).json();
      if(s.done){
        if(s.error)throw Error(s.error);
        var a=document.createElement('a');a.href='/api/file?id='+j.id;a.download=s.name;
        document.body.appendChild(a);a.click();a.remove();
        li.className='item ok';set(li,'✓  '+s.name);return;
      }
      set(li,(s.pct?'Downloading '+s.pct+'% · ':'Preparing · ')+short,Math.max(3,s.pct));pull=Math.max(pull,.2);
    }
  }catch(e){li.className='item err';set(li,'✗  '+short+' — '+e.message)}
}
async function go(){
  var urls=inp.value.split(/\s+/).filter(Boolean);inp.value='';
  for(var i=0;i<urls.length;i++){feed(urls[i]);await sleep(700)}
}
document.getElementById('f').onsubmit=function(e){e.preventDefault();go()};
inp.addEventListener('paste',function(){setTimeout(go,150)});
</script></body></html>`;
