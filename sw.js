const CACHE_NAME = "opex-shell-v2.9.6-push-notification";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./push-v1a.js",
  "./icons/nortura-logo.png",
  "./icons/opex-icon-192.png",
  "./icons/opex-icon-512.png"
];

// Register notification click handling BEFORE Firebase Messaging is imported.
// Keep every notification click inside the OpEx GitHub Pages/PWA scope.
self.addEventListener("notificationclick", event => {
  event.notification.close();

  const notificationData = event.notification?.data || {};
  const fcmMessage = notificationData.FCM_MSG || {};
  const requestedLink =
    notificationData.link ||
    fcmMessage?.data?.link ||
    fcmMessage?.fcmOptions?.link ||
    fcmMessage?.notification?.click_action ||
    self.registration.scope;

  let target;
  try {
    target = new URL(requestedLink, self.registration.scope).href;
  } catch {
    target = self.registration.scope;
  }

  if (!target.startsWith(self.registration.scope)) {
    target = self.registration.scope;
  }

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      const existing = clients.find(client => client.url.startsWith(self.registration.scope));
      if (existing) {
        return existing.navigate(target).catch(() => existing).then(() => existing.focus());
      }
      return self.clients.openWindow(target);
    })
  );
});

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
    // Notification payloads are rendered automatically by FCM/browser while
    // the PWA is backgrounded or closed. Do not call showNotification again,
    // otherwise the user receives duplicates.
    if (payload?.notification?.title || payload?.notification?.body) {
      console.log("[OpEx Push] Background notification received; browser handles display.");
      return;
    }

    // Keep a data-only fallback for diagnostics/legacy senders.
    const data = payload?.data || {};
    const title = data.title || "OpEx Hub";
    const body = data.body || "Du har et nytt varsel.";
    const link = data.link || payload?.fcmOptions?.link || self.registration.scope;

    return self.registration.showNotification(title, {
      body,
      icon: "./icons/opex-icon-192.png",
      badge: "./icons/opex-icon-192.png",
      tag: data.tag || "opex-notification",
      renotify: false,
      data: { link }
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
