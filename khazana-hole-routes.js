/* ════════════════════════════════════════════════════════════════════════════
 *  KHAZANA-HOLE — media extraction engine for SpaceKhazana's Music section
 *  ----------------------------------------------------------------------------
 *  Drop-in Express router. Zero npm dependencies beyond `express` (which your
 *  server already uses).
 *
 *    GET    /api/khazana-hole/health            engine status (yt-dlp / ffmpeg)
 *    GET    /api/khazana-hole/search?q=...      search YouTube, OR resolve a
 *                                               YouTube / YouTube Music URL / ID
 *    POST   /api/khazana-hole/download          { url | videoId, albumId? }
 *    GET    /api/khazana-hole/jobs/:id          job state + progress
 *    GET    /api/khazana-hole/jobs/:id/file     the finished, tagged .mp3
 *    GET    /api/khazana-hole/jobs/:id/cover    256px cover art (jpg)
 *    DELETE /api/khazana-hole/jobs/:id          cancel / clean up
 *
 *  Wire-up (in server.js, AFTER your auth middleware exists):
 *
 *    const khazanaHole = require('./khazana-hole-routes');
 *    app.use('/api/khazana-hole', khazanaHole({
 *      requireAuth,                       // your existing auth middleware
 *      // getUserId: req => req.user.id,  // only if your req.user shape differs
 *      // saveToStorage: async (info) => {...}   // optional, see below
 *    }));
 *
 *  Pipeline per download:
 *    metadata (yt-dlp -J)  →  audio download (yt-dlp bestaudio + thumbnail)
 *    →  convert + tag (ffmpeg: libmp3lame, ID3v2.3 title/artist/album/year +
 *       embedded square cover art)  →  done.
 *
 *  Getting the .mp3 into SpaceKhazana storage — two modes:
 *    1. DEFAULT (no hook): the finished file stays in a private temp dir and
 *       the browser pulls it from /jobs/:id/file, then pushes it through the
 *       app's normal upload pipeline (local disk, S3/R2, chunked — whatever
 *       you have configured). It lands in the chosen album exactly like a
 *       manual upload, so indexing/thumbnails/offline/trash all just work.
 *    2. OPTIONAL `saveToStorage` hook: if you pass one, the server saves the
 *       file itself and the browser skips the upload. The hook receives
 *       { userId, albumId, filePath, fileName, mimeType, size, coverPath,
 *         meta } and must return the created node (or anything truthy).
 * ════════════════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const WIN = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────────── input parsing ───────────────────────────── */

const ID_RE = /^[\w-]{11}$/;
const YT_HOST_RE = /^(?:(?:www|m|music)\.)?youtube\.com$|^youtu\.be$|^(?:www\.)?youtube-nocookie\.com$/i;
const LOOKS_LIKE_URL_RE = /^(?:https?:\/\/|(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be)\/)/i;

/**
 * Turns user input into a canonical YouTube video reference.
 *   → { kind:'video', id, url }   a single video
 *   → { kind:'search', q }        a plain search term
 * Throws an Error with .status = 400 for links we refuse (non-YouTube hosts,
 * playlist-only links). Everything yt-dlp ever sees is rebuilt from the 11-char
 * ID, never passed through from the user — so no flag/URL injection and no
 * way to point yt-dlp at other sites or local files.
 */
function parseInput(raw) {
  const s = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!s) throw httpError(400, 'Type a song name or paste a YouTube link.');
  // Bare video ID — only when it has a digit, "_" or "-" so an 11-letter word
  // like "heartbreaks" is still treated as a search. (The download endpoint
  // validates IDs strictly through videoRef(), so this only affects the search box.)
  if (ID_RE.test(s) && /[\d_-]/.test(s)) return videoRef(s);
  if (!LOOKS_LIKE_URL_RE.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) throw httpError(400, 'Only YouTube and YouTube Music links are supported.');
    return { kind: 'search', q: s.slice(0, 120) };
  }
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); }
  catch { throw httpError(400, 'That doesn\'t look like a valid link.'); }
  if (!/^https?:$/.test(u.protocol) || !YT_HOST_RE.test(u.hostname)) {
    throw httpError(400, 'Only YouTube and YouTube Music links are supported.');
  }
  let id = '';
  if (/^youtu\.be$/i.test(u.hostname)) id = u.pathname.split('/')[1] || '';
  else if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
  else {
    const m = /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname);
    if (m) id = m[1];
  }
  if (!ID_RE.test(id)) {
    if (u.searchParams.get('list') || /^\/(playlist|browse|channel|@)/.test(u.pathname)) {
      throw httpError(400, 'Playlist and channel links aren\'t supported — paste a single video link, or search by name.');
    }
    throw httpError(400, 'Couldn\'t find a video in that link.');
  }
  return videoRef(id);
}

function videoRef(id) {
  if (!ID_RE.test(String(id || ''))) throw httpError(400, 'That isn\'t a valid YouTube video ID.');
  return { kind: 'video', id, url: 'https://www.youtube.com/watch?v=' + id };
}

function httpError(status, message, code) {
  const e = new Error(message); e.status = status; e.code = code || 'bad_request'; return e;
}

/* ──────────────────────────── metadata helpers ─────────────────────────── */

function fmtDuration(sec) {
  sec = Math.round(Number(sec) || 0);
  if (sec <= 0) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

const NOISE_RE = /\s*[(\[【]\s*(?:official\s*)?(?:music\s*)?(?:video|audio|lyric\s*video|lyrics?|visuali[sz]er|hd|hq|4k|mv|m\/v|full\s*song|audio\s*only)\s*[)\]】]/gi;

function cleanArtist(a) {
  return String(a || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s+/g, ' ').trim();
}

/** Best-effort Title / Artist from yt-dlp's info dict (YT Music fields first). */
function normalizeMeta(info) {
  let title = String(info.track || info.title || 'Untitled').trim();
  let artist = cleanArtist(info.artist || info.creator || '');
  if (!artist) {
    // Plain YouTube upload: "Artist - Title (Official Video)" is the common shape.
    const m = /^(.{1,60}?)\s+[-–—]\s+(.+)$/.exec(title);
    if (m && !info.track) { artist = cleanArtist(m[1]); title = m[2]; }
  }
  if (!artist) artist = cleanArtist(info.channel || info.uploader || '');
  title = title.replace(NOISE_RE, '').replace(/\s+/g, ' ').trim() || 'Untitled';
  const year = String(info.release_year || (info.upload_date || '').slice(0, 4) || '');
  return {
    id: info.id,
    title,
    artist: artist || 'Unknown Artist',
    album: String(info.album || '').trim() || 'Khazana-Hole',
    year: /^\d{4}$/.test(year) ? year : '',
    duration: Math.round(Number(info.duration) || 0),
    thumbnail: info.id ? `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg` : '',
    sourceUrl: info.id ? `https://youtu.be/${info.id}` : ''
  };
}

function safeFileName(artist, title) {
  const base = (artist && artist !== 'Unknown Artist' ? `${artist} - ${title}` : title)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').replace(/^\.+/, '').trim().slice(0, 120).trim();
  return (base || 'track') + '.mp3';
}

/** Maps yt-dlp's stderr to a message a person can act on. */
function friendlyYtError(stderr) {
  const line = (String(stderr).split('\n').filter((l) => /ERROR/.test(l)).pop() || '').replace(/^.*?ERROR:\s*(?:\[[^\]]+\]\s*[\w-]*:\s*)?/, '');
  const l = line.toLowerCase();
  if (/private video/.test(l)) return { code: 'private', message: 'That video is private.' };
  if (/sign in to confirm your age|age[- ]restricted|inappropriate for some users/.test(l)) return { code: 'age', message: 'That video is age-restricted and can\'t be fetched without a signed-in session.' };
  if (/sign in to confirm you.?re not a bot|confirm you.?re not a bot/.test(l)) return { code: 'bot_check', message: 'YouTube is asking this server to prove it\'s not a bot. Set KH_COOKIES_BROWSER (e.g. chrome) on the server and retry.' };
  if (/not available in your country|blocked it in your country|geo/.test(l)) return { code: 'geo', message: 'That video isn\'t available in the server\'s region.' };
  if (/copyright|blocked it on copyright/.test(l)) return { code: 'copyright', message: 'That video is blocked for copyright reasons.' };
  if (/video unavailable|this video is not available|has been removed|account.*terminated|does not exist/.test(l)) return { code: 'unavailable', message: 'That video is unavailable or has been removed.' };
  if (/members-only|join this channel/.test(l)) return { code: 'members', message: 'That video is members-only.' };
  if (/premieres in|live event will begin/.test(l)) return { code: 'upcoming', message: 'That video hasn\'t premiered yet.' };
  if (/page needs to be reloaded/.test(l)) return { code: 'stale_session', message: 'YouTube rejected the session. Update yt-dlp (nightly) or re-export fresh cookies, then retry.' };
  if (/requested format is not available/.test(l)) return { code: 'format', message: 'No downloadable audio was found for that video.' };
  if (/larger than max-filesize|file is larger/.test(l)) return { code: 'too_big', message: 'That video is too large to convert.' };
  if (/unable to download|timed out|temporary failure|network|connection/.test(l)) return { code: 'network', message: 'Network problem while talking to YouTube. Try again in a moment.' };
  return { code: 'ytdlp', message: (line || 'Could not fetch that video.').slice(0, 200) };
}

/* ─────────────────────────────── the router ────────────────────────────── */

module.exports = function createKhazanaHole(options = {}) {
  const {
    requireAuth,
    getUserId = (req) => {
      const u = req.user || {};
      const id = u.id ?? u._id ?? u.userId ?? u.username ?? req.userId ?? req.userid ?? req.username;
      return id == null ? '' : String(id);
    },
    saveToStorage = null,
    autoInstall = true,
    binDir = __dirname,
    tmpRoot: tmpRootOpt = path.join(os.tmpdir(), 'khazana-hole'),
    maxDurationSec = 30 * 60,          // refuse mixes / hour-long streams
    maxConcurrent = 2,                 // simultaneous yt-dlp/ffmpeg pipelines (whole server)
    maxActivePerUser = 3,
    jobTtlMs = 30 * 60 * 1000,         // how long a finished job's file is kept
    mp3Quality = process.env.KH_MP3_QUALITY || '0', // libmp3lame VBR: 0 (best) … 9
    searchResults = 10
  } = options;

  if (typeof requireAuth !== 'function') {
    throw new Error('khazana-hole: pass your auth middleware as `requireAuth` — this router runs yt-dlp/ffmpeg and must never be public.');
  }

  const tmpRoot = path.resolve(tmpRootOpt); // sendFile() needs absolute paths
  const COOKIES_BROWSER = process.env.KH_COOKIES_BROWSER || '';
  const COOKIES_FILE = process.env.KH_COOKIES_FILE || '';

  /* ── engine discovery (yt-dlp + ffmpeg) ── */
  const have = (cmd, args) => { try { return spawnSync(cmd, args, { timeout: 15000 }).status === 0; } catch { return false; } };
  const eng = { yt: null, ffmpeg: null, ytVersion: '', note: '' };

  const ready = (async () => {
    try { fs.mkdirSync(tmpRoot, { recursive: true }); } catch { /* handled per job */ }

    // yt-dlp: env → PATH → binary next to this file (auto-fetched if allowed)
    if (process.env.YTDLP_PATH && have(process.env.YTDLP_PATH, ['--version'])) eng.yt = process.env.YTDLP_PATH;
    else if (have('yt-dlp', ['--version'])) eng.yt = 'yt-dlp';
    else {
      const f = path.join(binDir, WIN ? 'yt-dlp.exe' : 'yt-dlp');
      const stale = !fs.existsSync(f) || Date.now() - fs.statSync(f).mtimeMs > 7 * 864e5; // sites break often
      if (autoInstall && stale) {
        try {
          console.log('[khazana-hole] fetching yt-dlp…');
          const asset = WIN ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
          const r = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/' + asset);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          fs.writeFileSync(f + '.tmp', Buffer.from(await r.arrayBuffer()));
          fs.chmodSync(f + '.tmp', 0o755);
          fs.renameSync(f + '.tmp', f);
        } catch (e) { console.log('[khazana-hole] yt-dlp download failed:', e.message); }
      }
      if (fs.existsSync(f)) { try { fs.chmodSync(f, 0o755); } catch { /* windows */ } eng.yt = f; }
    }
    if (eng.yt) {
      try { eng.ytVersion = String(spawnSync(eng.yt, ['--version'], { timeout: 15000 }).stdout || '').trim(); } catch { /* ignore */ }
    }

    // ffmpeg: env → PATH → ffmpeg(.exe) next to this file (Windows: auto-fetched)
    if (process.env.FFMPEG_PATH && have(process.env.FFMPEG_PATH, ['-version'])) eng.ffmpeg = process.env.FFMPEG_PATH;
    else if (have('ffmpeg', ['-version'])) eng.ffmpeg = 'ffmpeg';
    else {
      const ff = path.join(binDir, WIN ? 'ffmpeg.exe' : 'ffmpeg');
      if (fs.existsSync(ff)) eng.ffmpeg = ff;
      else if (autoInstall && WIN) {
        try {
          console.log('[khazana-hole] fetching ffmpeg (one time, ~130 MB)…');
          const z = path.join(binDir, 'ffmpeg.zip'), tmp = path.join(binDir, 'ffmpeg-tmp');
          const r = await fetch('https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip');
          if (!r.ok) throw new Error('HTTP ' + r.status);
          await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(z));
          fs.mkdirSync(tmp, { recursive: true });
          if (spawnSync('tar', ['-xf', z, '-C', tmp]).status !== 0) throw new Error('unzip failed');
          const find = (d) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
              const p = path.join(d, e.name);
              if (e.isDirectory()) { const x = find(p); if (x) return x; } else if (e.name === 'ffmpeg.exe') return p;
            }
          };
          fs.copyFileSync(find(tmp), ff);
          fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(z, { force: true });
          eng.ffmpeg = ff;
        } catch (e) { console.log('[khazana-hole] ffmpeg setup failed:', e.message, '— install ffmpeg or set FFMPEG_PATH.'); }
      }
    }
    if (!eng.yt) eng.note = 'yt-dlp not found. Install it, put yt-dlp(.exe) next to khazana-hole-routes.js, or set YTDLP_PATH.';
    else if (!eng.ffmpeg) eng.note = 'ffmpeg not found. Install it, put ffmpeg(.exe) next to khazana-hole-routes.js, or set FFMPEG_PATH.';
    console.log('[khazana-hole] yt-dlp:', eng.yt ? `${eng.yt} ${eng.ytVersion}` : 'MISSING', '| ffmpeg:', eng.ffmpeg || 'MISSING');
  })();

  // Stale temp dirs from a previous run
  ready.then(() => {
    try {
      for (const d of fs.readdirSync(tmpRoot)) fs.rmSync(path.join(tmpRoot, d), { recursive: true, force: true });
    } catch { /* nothing to clean */ }
  });

  /* ── child-process helpers ── */
  function runCapture(cmd, args, { timeout = 45000 } = {}) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { windowsHide: true });
      let out = '', err = '', done = false;
      const t = setTimeout(() => { if (!done) { p.kill('SIGKILL'); reject(Object.assign(new Error('timed out'), { stderr: err })); } }, timeout);
      p.stdout.on('data', (d) => { out += d; if (out.length > 20e6) p.kill('SIGKILL'); });
      p.stderr.on('data', (d) => { err += d; if (err.length > 1e6) err = err.slice(-5e5); });
      p.on('error', (e) => { done = true; clearTimeout(t); reject(e); });
      p.on('close', (code) => {
        done = true; clearTimeout(t);
        if (code === 0) resolve(out);
        else reject(Object.assign(new Error('exit ' + code), { stderr: err, code }));
      });
    });
  }

  function ytBaseArgs() {
    // Recent yt-dlp needs a JS runtime to solve YouTube's signature challenge;
    // without one only storyboards are offered ("requested format is not available").
    // The server already runs on Node, so reuse that exact binary.
    const a = ['--no-warnings', '--no-playlist', '--socket-timeout', '20',
               '--js-runtimes', 'node:' + process.execPath];
    if (COOKIES_FILE) a.push('--cookies', COOKIES_FILE);
    else if (COOKIES_BROWSER) a.push('--cookies-from-browser', COOKIES_BROWSER);
    return a;
  }

  function engineGuard() {
    if (!eng.yt) throw httpError(503, eng.note || 'The media engine isn\'t ready yet.', 'engine_missing');
  }

  /* ── search ── */
  const searchCache = new Map(); // key → { t, data }
  const SEARCH_TTL = 5 * 60 * 1000;
  const rate = new Map();        // userId → [timestamps]
  function rateLimit(userId, max, windowMs) {
    const now = Date.now();
    const arr = (rate.get(userId) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { rate.set(userId, arr); return false; }
    arr.push(now); rate.set(userId, arr); return true;
  }

  function resultFromInfo(info) {
    const m = normalizeMeta(info);
    return {
      id: m.id,
      title: m.title,
      videoTitle: String(info.title || m.title),
      artist: m.artist,
      channel: String(info.channel || info.uploader || m.artist || ''),
      duration: m.duration,
      durationText: fmtDuration(m.duration),
      thumbnail: m.thumbnail,
      url: m.sourceUrl,
      live: info.live_status === 'is_live' || info.is_live === true
    };
  }

  async function doSearch(q) {
    const key = q.toLowerCase();
    const hit = searchCache.get(key);
    if (hit && Date.now() - hit.t < SEARCH_TTL) return hit.data;
    const n = Math.max(1, Math.min(20, searchResults));
    const out = await runCapture(eng.yt, [
      ...ytBaseArgs(), '--flat-playlist', '--dump-json', '--playlist-end', String(n), `ytsearch${n}:${q}`
    ], { timeout: 40000 });
    const results = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((i) => i && ID_RE.test(String(i.id || '')))
      .map(resultFromInfo)
      .filter((r) => !r.live);
    if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
    searchCache.set(key, { t: Date.now(), data: results });
    return results;
  }

  async function fetchInfo(videoUrl) {
    const out = await runCapture(eng.yt, [...ytBaseArgs(), '--dump-single-json', '--skip-download', '--', videoUrl], { timeout: 45000 });
    return JSON.parse(out);
  }

  /* ── jobs ── */
  const jobs = new Map();
  const queue = [];
  let running = 0;

  const STAGES = {
    queued: 'Waiting in line…',
    metadata: 'Fetching metadata…',
    downloading: 'Downloading audio…',
    converting: 'Converting audio…',
    tagging: 'Adding tags & cover art…',
    saving: 'Saving to SpaceKhazana…',
    done: 'Saved!',
    error: 'Failed'
  };

  function setState(job, state, pct) {
    job.state = state; job.stage = STAGES[state] || state;
    job.pct = pct == null ? 0 : Math.max(0, Math.min(100, Math.round(pct)));
    job.updatedAt = Date.now();
  }

  function dropJob(id) {
    const job = jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    try { job.kill && job.kill(); } catch { /* already gone */ }
    jobs.delete(id);
    fs.rm(job.dir, { recursive: true, force: true }, () => {});
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, j] of jobs) {
      const age = now - (j.finishedAt || j.createdAt);
      if (age > jobTtlMs) dropJob(id);
    }
    for (const [u, arr] of rate) { const f = arr.filter((t) => now - t < 120000); f.length ? rate.set(u, f) : rate.delete(u); }
  }, 60 * 1000);
  sweeper.unref();

  function pump() {
    while (running < maxConcurrent && queue.length) {
      const job = queue.shift();
      if (job.cancelled) continue;
      running++;
      runJob(job).catch((e) => failJob(job, e)).finally(() => { running--; pump(); });
    }
  }

  function failJob(job, e) {
    if (job.cancelled) return;
    const f = e && e.stderr ? friendlyYtError(e.stderr) : null;
    job.error = (e && e.userMessage) || (f && f.message) || (e && e.message) || 'Something went wrong.';
    job.errorCode = (e && e.errCode) || (f && f.code) || 'failed';
    job.finishedAt = Date.now();
    setState(job, 'error', 0);
    console.error('[khazana-hole] job', job.id, 'failed:', e && (e.ffErr || (e.stderr ? String(e.stderr).slice(-400) : e.message)));
  }

  /** Runs yt-dlp for the audio + thumbnail, parsing progress lines. */
  function ytDownload(job, videoUrl) {
    return new Promise((resolve, reject) => {
      const args = [
        ...ytBaseArgs(),
        '--newline', '-f', 'bestaudio/best', '--max-filesize', '200M',
        '--write-thumbnail', '--no-part',
        '--progress-template', 'download:PCT %(progress._percent_str)s',
        '-o', path.join(job.dir, 'src.%(ext)s'),
        '--', videoUrl
      ];
      const p = spawn(eng.yt, args, { windowsHide: true });
      job.kill = () => p.kill('SIGKILL');
      let err = '', buf = '';
      p.stdout.on('data', (d) => {
        buf += d; let m;
        const re = /PCT\s+([\d.]+)%/g;
        while ((m = re.exec(buf))) job.pctRaw = +m[1];
        if (job.pctRaw != null) setState(job, 'downloading', job.pctRaw);
        buf = buf.slice(-64);
      });
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('close', (code) => {
        job.kill = null;
        if (job.cancelled) return reject(new Error('cancelled'));
        if (code !== 0) return reject(Object.assign(new Error('yt-dlp failed'), { stderr: err }));
        const files = fs.readdirSync(job.dir);
        const audio = files.find((f) => /^src\.(?!jpe?g$|png$|webp$)/i.test(f));
        const thumb = files.find((f) => /^src\.(jpe?g|png|webp)$/i.test(f));
        if (!audio) return reject(Object.assign(new Error('no audio'), { stderr: 'ERROR: Requested format is not available' }));
        resolve({ audio: path.join(job.dir, audio), thumb: thumb ? path.join(job.dir, thumb) : null });
      });
    });
  }

  function ffmpegRun(job, args, onProgressUs, durationSec) {
    return new Promise((resolve, reject) => {
      const p = spawn(eng.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', ...(onProgressUs ? ['-progress', 'pipe:1'] : []), ...args], { windowsHide: true });
      job.kill = () => p.kill('SIGKILL');
      let err = '';
      p.stdout.on('data', (d) => {
        if (!onProgressUs || !durationSec) return;
        const m = /out_time_(?:us|ms)=(\d+)/.exec(String(d));
        // ffmpeg's out_time_ms is (confusingly) microseconds
        if (m) onProgressUs(Math.min(99, (+m[1] / 1e6 / durationSec) * 100));
      });
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('close', (code) => {
        job.kill = null;
        if (job.cancelled) return reject(new Error('cancelled'));
        code === 0 ? resolve() : reject(Object.assign(new Error('ffmpeg failed'), { userMessage: 'Audio conversion failed.', errCode: 'ffmpeg', stderr: '' }, { ffErr: err.slice(-400) }));
      });
    });
  }

  async function runJob(job) {
    fs.mkdirSync(job.dir, { recursive: true });

    // 1 — metadata
    setState(job, 'metadata', 0);
    const info = await fetchInfo(job.videoUrl);
    if (job.cancelled) return;
    if (info.is_live || info.live_status === 'is_live' || info.live_status === 'is_upcoming') {
      throw Object.assign(new Error('live'), { userMessage: 'Live streams can\'t be saved.', errCode: 'live' });
    }
    const dur = Number(info.duration) || 0;
    if (dur > maxDurationSec) {
      throw Object.assign(new Error('long'), { userMessage: `That video is ${fmtDuration(dur)} long — the limit is ${fmtDuration(maxDurationSec)}.`, errCode: 'too_long' });
    }
    job.meta = normalizeMeta(info);

    // 2 — download
    setState(job, 'downloading', 0);
    const src = await ytDownload(job, job.videoUrl);
    if (job.cancelled) return;

    // 3 — cover art (square crop; 600px for the ID3 tag, 256px for the UI)
    let cover600 = null, cover256 = null;
    if (src.thumb) {
      try {
        const crop = "crop='min(iw,ih)':'min(iw,ih)'";
        cover600 = path.join(job.dir, 'cover600.jpg');
        cover256 = path.join(job.dir, 'cover256.jpg');
        await ffmpegRun(job, ['-i', src.thumb, '-vf', `${crop},scale=600:600`, '-frames:v', '1', '-q:v', '3', cover600]);
        await ffmpegRun(job, ['-i', cover600, '-vf', 'scale=256:256', '-frames:v', '1', '-q:v', '5', cover256]);
      } catch (e) { if (job.cancelled) return; cover600 = cover256 = null; /* tag without art */ }
    }

    // 4 — convert to mp3 + write ID3 tags (+ embedded cover)
    setState(job, 'converting', 0);
    const outName = safeFileName(job.meta.artist, job.meta.title);
    const outPath = path.join(job.dir, 'out.mp3');
    const tags = [
      ['title', job.meta.title], ['artist', job.meta.artist], ['album_artist', job.meta.artist],
      ['album', job.meta.album], ['date', job.meta.year], ['comment', 'Saved with Khazana-Hole · ' + job.meta.sourceUrl]
    ].filter(([, v]) => v);
    const args = ['-i', src.audio];
    if (cover600) args.push('-i', cover600);
    args.push('-map', '0:a:0');
    if (cover600) args.push('-map', '1:v:0');
    args.push('-c:a', 'libmp3lame', '-q:a', String(mp3Quality));
    if (cover600) args.push('-c:v', 'copy', '-disposition:v:0', 'attached_pic', '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
    args.push('-id3v2_version', '3', '-write_id3v1', '1');
    for (const [k, v] of tags) args.push('-metadata', `${k}=${v}`);
    args.push(outPath);
    await ffmpegRun(job, args, (pct) => { setState(job, 'converting', pct); }, dur || null);
    if (job.cancelled) return;
    setState(job, 'tagging', 100);

    const st = fs.statSync(outPath);
    if (!st.size) throw Object.assign(new Error('empty'), { userMessage: 'Conversion produced an empty file.', errCode: 'ffmpeg' });
    job.file = { path: outPath, name: outName, size: st.size, cover: cover256 };

    // 5 — optional server-side save into SpaceKhazana storage
    if (typeof saveToStorage === 'function' && job.albumId) {
      setState(job, 'saving', 50);
      job.saved = await saveToStorage({
        userId: job.userId, albumId: job.albumId, filePath: outPath, fileName: outName,
        mimeType: 'audio/mpeg', size: st.size, coverPath: cover256, meta: job.meta
      });
    }

    job.finishedAt = Date.now();
    setState(job, 'done', 100);
  }

  function publicJob(job) {
    return {
      id: job.id,
      state: job.state,
      stage: job.stage,
      pct: job.pct,
      done: job.state === 'done',
      failed: job.state === 'error',
      error: job.error || null,
      errorCode: job.errorCode || null,
      meta: job.meta || null,
      result: job.state === 'done' ? {
        fileName: job.file.name,
        size: job.file.size,
        hasCover: !!job.file.cover,
        savedByServer: !!job.saved,
        node: job.saved && typeof job.saved === 'object' ? job.saved : undefined
      } : null
    };
  }

  /* ── express wiring ── */
  const router = express.Router();
  router.use(requireAuth);
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const needUser = (req, res) => {
    const id = getUserId(req);
    if (!id) { res.status(401).json({ error: 'Not signed in.' }); return null; }
    return id;
  };
  const ownJob = (req, res, userId) => {
    const job = jobs.get(req.params.id);
    if (!job || job.userId !== userId) { res.status(404).json({ error: 'That download has expired.' }); return null; }
    return job;
  };
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      if (res.headersSent) return;
      if (e && e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      const f = e && e.stderr ? friendlyYtError(e.stderr) : null;
      if (f) return res.status(502).json({ error: f.message, code: f.code });
      console.error('[khazana-hole]', e && (e.stack || e.message));
      res.status(500).json({ error: 'Something went wrong.', code: 'internal' });
    }
  };

  router.get('/health', wrap(async (req, res) => {
    await ready;
    res.json({
      ok: !!(eng.yt && eng.ffmpeg),
      ytdlp: !!eng.yt, ytdlpVersion: eng.ytVersion || null,
      ffmpeg: !!eng.ffmpeg,
      serverSave: typeof saveToStorage === 'function',
      note: eng.note || null
    });
  }));

  router.get('/search', wrap(async (req, res) => {
    const userId = needUser(req, res); if (!userId) return;
    await ready; engineGuard();
    if (!rateLimit('s:' + userId, 20, 60 * 1000)) throw httpError(429, 'Too many searches — wait a few seconds.', 'rate_limited');
    const parsed = parseInput(req.query.q);
    if (parsed.kind === 'video') {
      const info = await fetchInfo(parsed.url);
      if (info.is_live || info.live_status === 'is_live') throw httpError(400, 'Live streams can\'t be saved.', 'live');
      return res.json({ query: String(req.query.q), mode: 'url', results: [resultFromInfo(info)] });
    }
    const results = await doSearch(parsed.q);
    res.json({ query: parsed.q, mode: 'search', results });
  }));

  router.post('/download', express.json({ limit: '10kb' }), wrap(async (req, res) => {
    const userId = needUser(req, res); if (!userId) return;
    await ready; engineGuard();
    if (!eng.ffmpeg) throw httpError(503, eng.note, 'engine_missing');
    const body = req.body || {};
    const parsed = body.videoId ? videoRef(body.videoId) : parseInput(body.url);
    if (parsed.kind !== 'video') throw httpError(400, 'Pick a result, or paste a YouTube link.');
    if (!rateLimit('d:' + userId, 15, 10 * 60 * 1000)) throw httpError(429, 'Too many downloads — slow down a little.', 'rate_limited');

    // Same user + same video already in flight → hand back that job
    for (const j of jobs.values()) {
      if (j.userId === userId && j.videoId === parsed.id && j.state !== 'error') return res.json({ jobId: j.id, reused: true });
    }
    let active = 0;
    for (const j of jobs.values()) if (j.userId === userId && j.state !== 'done' && j.state !== 'error') active++;
    if (active >= maxActivePerUser) throw httpError(429, `You already have ${active} downloads running — wait for one to finish.`, 'too_many');

    const id = crypto.randomBytes(10).toString('hex');
    const job = {
      id, userId, videoId: parsed.id, videoUrl: parsed.url,
      albumId: body.albumId ? String(body.albumId).slice(0, 128) : null,
      dir: path.join(tmpRoot, id), createdAt: Date.now(), finishedAt: 0,
      state: 'queued', stage: STAGES.queued, pct: 0, meta: null
    };
    jobs.set(id, job);
    queue.push(job);
    pump();
    res.status(202).json({ jobId: id });
  }));

  router.get('/jobs/:id', wrap(async (req, res) => {
    const userId = needUser(req, res); if (!userId) return;
    const job = ownJob(req, res, userId); if (!job) return;
    res.json(publicJob(job));
  }));

  router.get('/jobs/:id/file', wrap(async (req, res) => {
    const userId = needUser(req, res); if (!userId) return;
    const job = ownJob(req, res, userId); if (!job) return;
    if (job.state !== 'done' || !job.file) return res.status(409).json({ error: 'Not ready yet.' });
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Disposition', `attachment; filename="track.mp3"; filename*=UTF-8''${encodeURIComponent(job.file.name)}`);
    res.set('X-Khazana-Filename', encodeURIComponent(job.file.name));
    res.sendFile(job.file.path, { acceptRanges: true, dotfiles: 'allow', headers: { 'Content-Type': 'audio/mpeg' } });
  }));

  router.get('/jobs/:id/cover', wrap(async (req, res) => {
    const userId = needUser(req, res); if (!userId) return;
    const job = ownJob(req, res, userId); if (!job) return;
    if (!job.file || !job.file.cover) return res.status(404).json({ error: 'No cover art.' });
    res.set('Content-Type', 'image/jpeg');
    res.sendFile(job.file.cover, { dotfiles: 'allow' });
  }));

  router.delete('/jobs/:id', wrap(async (req, res) => {
    const userId = needUser(req, res); if (!userId) return;
    const job = ownJob(req, res, userId); if (!job) return;
    dropJob(job.id);
    res.json({ ok: true });
  }));

  router.ready = ready;
  router.engine = eng;
  // exposed for tests
  router._internals = { parseInput, normalizeMeta, safeFileName, friendlyYtError, fmtDuration };
  return router;
};

module.exports.parseInput = parseInput;
module.exports.videoRef = videoRef;
