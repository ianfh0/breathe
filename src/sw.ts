/// <reference lib="webworker" />
import { setCacheNameDetails } from 'workbox-core'
import { precacheAndRoute } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { CacheFirst, NetworkFirst } from 'workbox-strategies'

declare const self: ServiceWorkerGlobalScope

const CACHE_VERSION = 'breathe-timers-v3'

setCacheNameDetails({ prefix: CACHE_VERSION })

precacheAndRoute(self.__WB_MANIFEST)

registerRoute(
  ({ request }) => request.mode === 'navigate',
  new NetworkFirst({
    cacheName: `${CACHE_VERSION}-pages`,
    networkTimeoutSeconds: 4,
  }),
)

registerRoute(
  ({ request, url }) =>
    request.method === 'GET' &&
    (url.pathname.endsWith('/index.html') || url.pathname.endsWith('/breathe/')),
  new NetworkFirst({
    cacheName: `${CACHE_VERSION}-pages`,
    networkTimeoutSeconds: 4,
  }),
)

registerRoute(
  ({ url }) => /\/assets\/[^/]+-[A-Za-z0-9_-]+\.(js|css)$/.test(url.pathname),
  new CacheFirst({
    cacheName: `${CACHE_VERSION}-assets`,
  }),
)

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names.filter((name) => !name.includes(CACHE_VERSION)).map((name) => caches.delete(name)),
      )
      await self.clients.claim()
    })(),
  )
})
