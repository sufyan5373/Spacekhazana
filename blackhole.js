// BLACKHOLE — single file, zero npm deps. Run: node blackhole.js  ->  http://localhost:3000
// Auto-fetches yt-dlp on first run (YouTube, Instagram, TikTok, X, Facebook, Reddit, 1000+ sites).
// Optional: install ffmpeg for 1080p+/mp3. Instagram/private stuff: set BH_COOKIES_BROWSER=firefox (or chrome, edge).
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const dns = require('dns').promises, crypto = require('crypto');
const { spawn, spawnSync } = require('child_process'), { Readable } = require('stream'), { pipeline } = require('stream/promises');
const PORT = process.env.PORT || 3000, COOKIES = process.env.BH_COOKIES_BROWSER || '', WIN = process.platform === 'win32';
const have = (c, a) => { try { return spawnSync(c, a).status === 0 } catch { return false } };
const FFMPEG = have('ffmpeg', ['-version']);

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
  let got = 0; const rs = Readable.fromWeb(r.body);
  rs.on('data', d => { got += d.length; if (total && !enc) job.pct = got / total * 100; });
  await pipeline(rs, fs.createWriteStream(path.join(job.dir, name)));
  job.name = name; job.file = path.join(job.dir, name);
}
function ytdlp(job, url) {
  return new Promise((res, rej) => {
    const a = ['--no-playlist', '--newline', '--no-warnings', '--windows-filenames', '--progress-template', 'download:PCT %(progress._percent_str)s',
      '-o', path.join(job.dir, '%(title).80B.%(ext)s')];
    if (job.mode === 'audio') a.push(...(FFMPEG ? ['-x', '--audio-format', 'mp3'] : ['-f', 'ba/b']));
    else a.push(...(FFMPEG ? ['-f', 'bv*+ba/b', '-S', 'vcodec:h264,res,acodec:m4a', '--merge-output-format', 'mp4'] : ['-f', 'b/best']));
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
    if (YT) { try { await ytdlp(job, url); } catch (e) { if (r && r.ok) await page(); else throw e; } }
    else if (r && r.ok) await page();
    else throw Error('Source returned ' + (r ? r.status : 'an error'));
  } catch (e) { job.error = e.message; }
  finally { job.done = true; }
}

// ---------- http ----------
const j = (res, c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), q = u.searchParams;
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
  if (u.pathname === '/api/start') {
    let link = (q.get('url') || '').trim(); if (!link) return j(res, 400, { error: 'No link' });
    if (!/^[a-z]+:\/\//i.test(link)) link = 'https://' + link;
    const id = crypto.randomBytes(8).toString('hex');
    const job = { url: link, mode: q.get('mode') === 'audio' ? 'audio' : 'video', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'bh-')), pct: 0, done: false };
    jobs.set(id, job); setTimeout(() => { job.kill && job.kill(); drop(id); }, 30 * 60e3); run(job);
    return j(res, 200, { id });
  }
  const job = jobs.get(q.get('id'));
  if (u.pathname === '/api/status') {
    if (!job) return j(res, 404, { error: 'Expired' });
    return j(res, 200, { done: job.done, pct: Math.round(job.pct || 0), error: job.error, name: job.name });
  }
  if (u.pathname === '/api/file') {
    if (!job || !job.file) return j(res, 404, { error: 'Not ready' });
    const st = fs.statSync(job.file);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size, 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(job.name) });
    fs.createReadStream(job.file).pipe(res); res.on('close', () => drop(q.get('id'))); return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log('Black hole open → http://localhost:' + PORT));

// ---------- page ----------
const PAGE = String.raw`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blackhole</title>
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#000;color:#eee;font-family:system-ui,Segoe UI,sans-serif;overflow-x:hidden}
canvas{position:fixed;inset:0;z-index:0}
main{position:relative;z-index:1;min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding:0 16px 4vh}
h1{font-weight:300;letter-spacing:.4em;font-size:14px;color:#ffb066;margin:0 0 12px;text-transform:uppercase}
form{display:flex;width:min(640px,100%);border:1px solid #ff8a1f55;border-radius:999px;background:#0008;backdrop-filter:blur(8px);box-shadow:0 0 40px #ff8a1f22;overflow:hidden}
input{flex:1;background:none;border:0;outline:0;color:#fff;font-size:16px;padding:16px 22px;min-width:0}
button.go{border:0;background:linear-gradient(135deg,#ff8a1f,#ff4d00);color:#000;font-weight:700;padding:0 26px;cursor:pointer;font-size:15px}
.modes{display:flex;gap:8px;margin-top:10px}
.modes button{background:#0008;color:#999;border:1px solid #ff8a1f33;border-radius:99px;padding:5px 16px;font-size:12px;cursor:pointer}
.modes button.on{color:#000;background:#ffb066;border-color:#ffb066}
ul{list-style:none;margin:14px 0 0;padding:0;width:min(640px,100%);max-height:26vh;overflow:auto;font-size:13px;color:#aaa}
li{padding:6px 12px;border-left:2px solid #ff8a1f55;margin-bottom:4px;word-break:break-all}
small{margin-top:10px;color:#666;font-size:11px;text-align:center}
</style></head><body>
<canvas id="c"></canvas>
<main>
<h1>Blackhole</h1>
<form id="f"><input id="u" placeholder="Paste any link — YouTube, Instagram, TikTok, files…" autocomplete="off" autofocus><button class="go">Swallow</button></form>
<div class="modes"><button type="button" id="mv" class="on">Video</button><button type="button" id="ma">Audio</button></div>
<ul id="log"></ul>
<small>Paste one or many links. Only download what you have the right to.</small>
</main>
<script>
var c=document.getElementById('c'),x=c.getContext('2d'),W,H,cx,cy,pull=0,fly=[],P=[],mode='video';
function size(){W=c.width=innerWidth;H=c.height=innerHeight;cx=W/2;cy=H*.34}
addEventListener('resize',size);size();
function R(){return Math.min(W,H)*.085}
function mk(p){p=p||{};p.a=Math.random()*6.283;p.r=R()*1.4+Math.random()*Math.min(W,H)*.55;p.s=.5+Math.random()*.8;p.h=18+Math.random()*34;p.z=Math.random()*1.5+.4;return p}
for(var i=0;i<650;i++)P.push(mk());
function dot(p,front){
  var px=cx+Math.cos(p.a)*p.r,py=cy+Math.sin(p.a)*p.r*.32;
  if((Math.sin(p.a)>0)!==front)return;
  var near=Math.max(0,1-p.r/(R()*4));
  x.fillStyle='hsl('+p.h+',100%,'+(50+near*45)+'%)';x.globalAlpha=.35+near*.65;x.fillRect(px,py,p.z,p.z);
}
function frame(){
  x.globalAlpha=1;x.fillStyle='rgba(0,0,0,.2)';x.fillRect(0,0,W,H);
  var r0=R(),i;
  for(i=0;i<P.length;i++){var p=P[i];p.a+=p.s*(r0*1.8/p.r)*(.022+pull*.05);p.r-=(.12+pull*2.5)*(1+r0/p.r);if(p.r<r0*.95)mk(p);}
  for(i=0;i<P.length;i++)dot(P[i],false);
  x.globalAlpha=1;x.beginPath();x.arc(cx,cy,r0,0,6.283);x.fillStyle='#000';
  x.shadowColor='#ff8a1f';x.shadowBlur=35+pull*70;x.fill();x.shadowBlur=0;
  for(i=0;i<P.length;i++)dot(P[i],true);
  x.globalAlpha=1;x.font='14px monospace';x.textAlign='center';
  for(i=fly.length-1;i>=0;i--){var f=fly[i];f.k+=.018;var e=f.k*f.k;
    var fx=f.x+(cx-f.x)*e+Math.sin(f.k*9)*(1-f.k)*30,fy=f.y+(cy-f.y)*e;
    x.save();x.translate(fx,fy);x.rotate(f.k*8);x.scale(1-f.k*.95,1-f.k*.95);
    x.fillStyle='rgba(255,200,140,'+(1-f.k*.6)+')';x.fillText(f.t,0,0);x.restore();
    if(f.k>=1)fly.splice(i,1);}
  pull*=.965;requestAnimationFrame(frame);
}
frame();
var log=document.getElementById('log'),inp=document.getElementById('u');
function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
async function feed(u){
  var short=u.replace(/^https?:\/\//,'').slice(0,40);
  fly.push({t:short,x:W/2,y:H-100,k:0});pull=1;
  var li=document.createElement('li');li.textContent='… '+short;log.prepend(li);
  try{
    var r=await fetch('/api/start?mode='+mode+'&url='+encodeURIComponent(u)),j=await r.json();
    if(!r.ok)throw Error(j.error||'Failed');
    for(;;){
      await sleep(800);
      var s=await (await fetch('/api/status?id='+j.id)).json();
      if(s.error&&!s.done)throw Error(s.error);
      if(s.done){
        if(s.error)throw Error(s.error);
        var a=document.createElement('a');a.href='/api/file?id='+j.id;a.download=s.name;
        document.body.appendChild(a);a.click();a.remove();
        li.textContent='✓ '+s.name;li.style.borderColor='#5f5';return;
      }
      li.textContent='↓ '+short+' · '+s.pct+'%';pull=Math.max(pull,.25);
    }
  }catch(e){li.textContent='✗ '+short+' — '+e.message;li.style.borderColor='#f55'}
}
async function go(){
  var urls=inp.value.split(/\s+/).filter(Boolean);inp.value='';
  for(var i=0;i<urls.length;i++){feed(urls[i]);await sleep(700)}
}
document.getElementById('f').onsubmit=function(e){e.preventDefault();go()};
inp.addEventListener('paste',function(){setTimeout(go,150)});
function setMode(m){mode=m;document.getElementById('mv').className=m=='video'?'on':'';document.getElementById('ma').className=m=='audio'?'on':''}
document.getElementById('mv').onclick=function(){setMode('video')};
document.getElementById('ma').onclick=function(){setMode('audio')};
</script></body></html>`;
