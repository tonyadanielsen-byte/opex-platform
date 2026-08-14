const CACHE_NAME = "opex-shell-v2.9.1-mobilefix";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./push-v1a.js",
  "./icons/nortura-logo.png",
  "./icons/opex-icon-192.png",
  "./icons/opex-icon-512.png"
];

// Firebase Cloud Messaging for web push. Failure to load the remote SDK must
// never stop the ordinary OpEx offline/service-worker functionality.
let messaging = null;
try {
  importScripts("https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js");
  importScripts("https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js");
  firebase.initializeApp({
    apiKey: "AIzaSyDT6bW6kErdyhVK3WTMDEERsCLRTdjnoTg",
    authDomain: "opex-nortura.firebaseapp.com",
    databaseURL: "https://opex-nortura-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "opex-nortura",
    storageBucket: "opex-nortura.firebasestorage.app",
    messagingSenderId: "72695195747",
    appId: "1:72695195747:web:cb8ca9c1970b4fc3c9b056"
  });
  messaging = firebase.messaging();
  messaging.onBackgroundMessage(payload => {
    // Notification payloads from Firebase Console/FCM are displayed by FCM.
    // Data-only messages used by the later automatic sender need us to display them.
    if (payload && payload.notification) return;
    const data = payload?.data || {};
    self.registration.showNotification(data.title || "OpEx Hub", {
      body: data.body || "Du har et nytt varsel.",
      icon: "./icons/opex-icon-192.png",
      badge: "./icons/opex-icon-192.png",
      tag: data.tag || "opex-notification",
      data: { link: data.link || "./" }
    });
  });
} catch (error) {
  console.error("[OpEx Push] Firebase Messaging kunne ikke initialiseres i service worker:", error);
}

function injectPushModule(response) {
  if (!response) return response;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;
  return response.text().then(html => {
    const injected = html.includes("push-v1a.js")
      ? html
      : html.replace("</body>", '<script src="./push-v1a.js"></script></body>');
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(injected, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  });
}

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const link = event.notification?.data?.link || "./";
  const target = new URL(link, self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      const existing = clients.find(client => client.url.startsWith(self.registration.scope));
      if (existing) {
        existing.navigate(target).catch(() => {});
        return existing.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put("./index.html", copy));
          return injectPushModule(response);
        })
        .catch(() => caches.match("./index.html").then(injectPushModule))
    );
    return;
  }

  // Keep the push helper fresh. It contains the mobile header/profile fix and
  // must not get stuck behind an old cache on installed PWAs.
  if (requestUrl.pathname.endsWith("/push-v1a.js")) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      return response;
    }))
  );
});
