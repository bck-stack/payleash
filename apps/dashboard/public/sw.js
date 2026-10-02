/* PayLeash service worker: Web Push for held calls, and a small offline shell. No data is cached except the app shell. */
const SHELL = "payleash-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icons/icon.svg"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first for pages, so a new release shows up; the cached shell is only for when the network is gone.
// The API is never cached.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname === "/healthz") return;
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/")));
  }
});

self.addEventListener("push", (event) => {
  let data = { title: "PayLeash", body: "An agent needs your approval.", url: "/approvals" };
  try {
    data = { ...data, ...event.data.json() };
  } catch (e) {
    /* plain-text or empty payload: keep the defaults */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag || "payleash",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url },
      requireInteraction: true,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/approvals", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.navigate(target);
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
