/* SpaceKhazana Service Worker - offline support
   Strategy:
   - App shell (/, /app, manifest, icons, CDN scripts): cache-first, so the
     app boots instantly with zero network.
   - API GET requests (file lists, usage, etc.): network-first, falling back
     to the last good cached response when offline. Cached entries are
     scoped per signed-in user, and large/binary bodies are never stored.
   - Everything else same-origin: cache-first with background refresh.
   - Non-GET requests (uploads, deletes, etc.), Range requests, health
     pings and third-party origins always go straight to the network.
*/

const VERSION = 'v33';
const SHELL_CACHE = `sk-shell-${VERSION}`;
const RUNTIME_CACHE = `sk-runtime-${VERSION}`;

// Backend on Render (must match PROD_API_HOST in index.html). Frontend is on
// Vercel, so API calls are cross-origin and need to be recognised here.
const API_ORIGIN = 'https://spacekhazana.onrender.com';

// Third-party hosts whose static files are part of the app shell.
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];

// Biggest API body we are willing to keep for offline use.
const MAX_CACHED_BYTES = 8 * 1024 * 1024;

const SHELL_ASSETS = [
  '/',
  // '/' serves the site.html landing page (logged-out default); '/app' is
  // the actual drive UI (index.html). Both are precached so a logged-in
  // user can still open their drive while offline.
  '/app',
  '/icons/manifest.json',
  '/icons/favicon.ico',
  '/icons/favicon-16.png',
  '/icons/favicon-32.png',
  '/icons/favicon-48.png',
  '/icons/apple-touch-icon.png',
  '/icons/apple-touch-icon-152.png',
  '/icons/apple-touch-icon-167.png',
  '/icons/android-chrome-192.png',
  '/icons/android-chrome-512.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-icon-192.png',
  '/icons/maskable-icon-512.png',
  '/videos/spacekhazanalogin.mp4',
  // PDF viewer + its engines, so PDFs (and highlight / text annotation, and
  // saving the annotated copy) keep working offline once they've been used.
  '/pdf-viewer.js',
  '/vendor/gsap.min.js',
  '/vendor/ScrollTrigger.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
  // fontkit lets saved edits reuse the PDF's own embedded font offline
  'https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js'
  // Icons are built into index.html now, so there is no icon library to cache.
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch(() => {
            // One failed asset (e.g. CDN hiccup) must not block install.
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // The page reloads itself on `controllerchange`, so no extra message is
  // needed here (the old 'sw-updated' broadcast had no listener).
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('sk-') && k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  // Lets the page wipe the per-user API cache on demand.
  if (event.data === 'clearRuntime') event.waitUntil(caches.delete(RUNTIME_CACHE));
});

/* ───────────── helpers ───────────── */

function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}

// API endpoints that are safe and useful to serve from cache when offline.
function isCacheableApi(url) {
  if (!isApiRequest(url)) return false;
  const p = url.pathname;
  if (p.startsWith('/api/auth/')) return false;          // never show stale permission state
  if (p.startsWith('/api/manual-payments/')) return false; // payment status must be live
  if (p.startsWith('/api/admin/')) return false;         // admin data + CNIC images: never cache
  if (p === '/api/ping') return false;                   // must reflect the real connection
  if (p.startsWith('/api/khazana-hole/')) return false;  // live search / job progress
  if (p.startsWith('/api/files/download')) return false; // big binary downloads
  return true;
}

// Responses are keyed per user (hash of the auth token) so one account can
// never be served another account's cached lists on a shared device.
function userScopedKey(request) {
  const token = request.headers.get('x-auth-token');
  if (!token) return request;
  let hash = 5381;
  for (let i = 0; i < token.length; i++) hash = ((hash << 5) + hash + token.charCodeAt(i)) | 0;
  const u = new URL(request.url);
  u.searchParams.set('__sku', (hash >>> 0).toString(36));
  return new Request(u.toString());
}

function isStorable(response, { allowRedirected = false } = {}) {
  if (!response || !response.ok || response.status !== 200) return false;
  if (response.type !== 'basic' && response.type !== 'cors') return false;
  // A redirected response can't be used to answer a navigation later.
  if (response.redirected && !allowRedirected) return false;
  const len = parseInt(response.headers.get('content-length') || '0', 10);
  if (len > MAX_CACHED_BYTES) return false;
  const type = (response.headers.get('content-type') || '').toLowerCase();
  if (/^(video|audio)\//.test(type) || type.includes('octet-stream') || type.includes('zip')) return false;
  return true;
}

function put(event, cache, key, response) {
  const job = cache.put(key, response).catch(() => { /* quota or opaque: ignore */ });
  event.waitUntil(job);
}

async function networkFirst(event, request, cacheName) {
  const cache = await caches.open(cacheName);
  const key = userScopedKey(request);
  try {
    const fresh = await fetch(request);
    if (isStorable(fresh)) put(event, cache, key, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(event, request, cacheName, options = {}) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, options);
  if (cached) {
    // Refresh in the background so the shell doesn't go stale forever.
    event.waitUntil(
      fetch(request)
        .then((fresh) => { if (isStorable(fresh)) return cache.put(request, fresh); })
        .catch(() => {})
    );
    return cached;
  }
  const fresh = await fetch(request);
  if (isStorable(fresh)) put(event, cache, request, fresh.clone());
  return fresh;
}

/* ───────────── fetch ───────────── */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // can't serve writes offline

  const url = new URL(request.url);

  // Media seeking: a Range request must always go straight to the network.
  // The Cache API can't store 206 responses, and answering a byte-range
  // request with a cached full 200 breaks video/audio playback.
  if (request.headers.get('range')) return;

  // Uploaded media is streamed by the server (with Range support); never
  // shadow it with the cache layer.
  if (url.pathname.startsWith('/uploads/')) return;

  // Installer files and the release list are big and must always be live.
  if (url.pathname.startsWith('/downloads/')) return;

  const sameOrigin = url.origin === self.location.origin;
  const isApiOrigin = !sameOrigin && url.pathname.startsWith('/api/'); // backend on another origin (Render)
  if (!sameOrigin && !isApiOrigin && !CDN_HOSTS.includes(url.hostname)) return; // favicons, fonts, etc.

  // Full page navigations -> app shell, cache-first with background refresh.
  // Query strings (e.g. /?stay=1) must still hit the cached page offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      cacheFirst(event, request, SHELL_CACHE, { ignoreSearch: true }).catch(async () => {
        const fallback = url.pathname.startsWith('/app') ? '/app' : '/';
        const hit = (await caches.match(fallback)) || (await caches.match('/'));
        return hit || Response.error();
      })
    );
    return;
  }

  if ((sameOrigin || isApiOrigin) && isApiRequest(url)) {
    if (!isCacheableApi(url)) return; // auth, ping, live jobs: network only
    // No cache and no network: fail like a normal offline fetch so the
    // app's own offline handling runs (a fake 200 made callers think the
    // data was valid, and made the offline banner never appear).
    event.respondWith(networkFirst(event, request, RUNTIME_CACHE).catch(() => Response.error()));
    return;
  }

  // Static assets: same-origin app shell pieces, CDN scripts, icons.
  event.respondWith(
    cacheFirst(event, request, SHELL_CACHE).catch(async () => (await caches.match(request)) || Response.error())
  );
});
