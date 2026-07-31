/* Service worker for the kids site.
 *
 * Two jobs:
 *   1. Keep the app shell (page, data, thumbs, icons) working with no connection.
 *   2. Serve episodes the user explicitly saved, including Range requests — a
 *      <video> element seeks by asking for byte ranges, and the Cache API only
 *      ever hands back whole responses, so ranges are sliced here.
 *
 * Videos are never cached automatically: they are hundreds of megabytes. The page
 * writes them into VIDEO_CACHE on request (see saveEpisodeOffline in index-kids.html)
 * and this worker just reads from it.
 */

const VERSION = 'v1';
const SHELL_CACHE = `kids-shell-${VERSION}`;
const ASSET_CACHE = `kids-assets-${VERSION}`;
const VIDEO_CACHE = 'kids-videos-v1'; // not versioned: survives app updates

const SHELL_URLS = [
  './',
  'index.html',
  'data.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Individually, so one 404 cannot fail the whole install.
    await Promise.all(SHELL_URLS.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        console.warn('[sw] shell precache skipped', url, err);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, ASSET_CACHE, VIDEO_CACHE]);
    const names = await caches.keys();
    // Drop old shell/asset versions but never touch saved videos.
    await Promise.all(names.map((n) => (keep.has(n) ? null : caches.delete(n))));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isVideoRequest(url) {
  return /\.(mp4|webm|mkv)$/i.test(new URL(url).pathname);
}

function isAssetRequest(url) {
  return /\.(png|jpe?g|webp|svg|ico)$/i.test(new URL(url).pathname);
}

/** Build a 206 response by slicing a cached full-body response. */
async function rangeResponse(cached, rangeHeader) {
  const buf = await cached.arrayBuffer();
  const total = buf.byteLength;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());

  if (!m) {
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': cached.headers.get('Content-Type') || 'video/mp4',
        'Content-Length': String(total),
        'Accept-Ranges': 'bytes',
      },
    });
  }

  let start;
  let end;
  if (m[1] === '') {
    // suffix form: last N bytes
    const suffix = parseInt(m[2], 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return new Response(buf, { status: 200 });
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? total - 1 : parseInt(m[2], 10);
  }

  if (!Number.isFinite(start) || start >= total) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${total}` },
    });
  }
  end = Math.min(Number.isFinite(end) ? end : total - 1, total - 1);

  const slice = buf.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      'Content-Type': cached.headers.get('Content-Type') || 'video/mp4',
      'Content-Length': String(slice.byteLength),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

async function handleVideo(request) {
  const cache = await caches.open(VIDEO_CACHE);
  // Range requests never match a cached 200 directly, so match on URL.
  const cached = await cache.match(request.url, { ignoreVary: true, ignoreSearch: true });

  if (cached) {
    const range = request.headers.get('range');
    return range ? rangeResponse(cached, range) : cached.clone();
  }

  // Not saved offline — go to network, and let the failure surface as-is.
  return fetch(request);
}

async function handleAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    return cached || Response.error();
  }
}

async function handleNavigation(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('index.html', res.clone());
    }
    return res;
  } catch (err) {
    const cache = await caches.open(SHELL_CACHE);
    return (await cache.match('index.html')) || (await cache.match('./')) || Response.error();
  }
}

async function handleShellAsset(request) {
  // data.js: fresh when online, cached when not.
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, res.clone());
    }
    return res;
  } catch (err) {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request, { ignoreVary: true, ignoreSearch: true });
    return cached || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }
  if (isVideoRequest(request.url)) {
    event.respondWith(handleVideo(request));
    return;
  }
  if (isAssetRequest(request.url)) {
    event.respondWith(handleAsset(request));
    return;
  }
  if (/\/(data\.js|manifest\.webmanifest)$/.test(url.pathname)) {
    event.respondWith(handleShellAsset(request));
  }
});
