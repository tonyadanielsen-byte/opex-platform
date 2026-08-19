const CACHE_NAME = "opex-shell-v2.9.13-activity-v36";
const APP_SHELL = [
  "./", "./index.html", "./manifest.webmanifest", "./push-v1a.js", "./push-deeplink-v1d.js", "./ui-v1f.css", "./ui-v1f.js",
  "./icons/nortura-logo.png", "./icons/opex-icon-192.png", "./icons/opex-icon-512.png", "./icons/opex-status-badge-v2.png"
];

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const notificationData = event.notification?.data || {};
  const fcmMessage = notificationData.FCM_MSG || {};
  const requestedLink = notificationData.link || fcmMessage?.data?.link || fcmMessage?.fcmOptions?.link || fcmMessage?.notification?.click_action || self.registration.scope;
  let target;
  try { target = new URL(requestedLink, self.registration.scope).href; } catch { target = self.registration.scope; }
  if (!target.startsWith(self.registration.scope)) target = self.registration.scope;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
    const existing = clients.find(client => client.url.startsWith(self.registration.scope));
    if (existing) return existing.navigate(target).catch(() => existing).then(() => existing.focus());
    return self.clients.openWindow(target);
  }));
});

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
    if (payload?.notification?.title || payload?.notification?.body) return;
    const data = payload?.data || {};
    const title = data.title || "OpEx Hub";
    const body = data.body || "Du har et nytt varsel.";
    const link = data.link || payload?.fcmOptions?.link || self.registration.scope;
    return self.registration.showNotification(title, {
      body,
      icon: "./icons/opex-icon-192.png",
      badge: "./icons/opex-status-badge-v2.png?v=2",
      tag: data.tag || "opex-notification",
      renotify: false,
      data: { link, taskId: data.taskId || "" }
    });
  });
} catch (error) { console.error("[OpEx Push] Firebase Messaging kunne ikke initialiseres i service worker:", error); }

function injectPushModule(response) {
  if (!response) return response;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;
  return response.text().then(html => {
    let injected = html.includes("push-v1a.js") ? html : html.replace("</body>", '<script src="./push-v1a.js"></script></body>');
    if (!injected.includes("push-deeplink-v1d.js")) injected = injected.replace("</body>", '<script src="./push-deeplink-v1d.js"></script></body>');
    if (!injected.includes("ui-v1f.css")) injected = injected.replace("</head>", '<link rel="stylesheet" href="./ui-v1f.css?v=1"></head>');
    if (!injected.includes("ui-v1f.js")) injected = injected.replace("</body>", '<script src="./ui-v1f.js?v=35"></script></body>');
    const headers = new Headers(response.headers); headers.delete("content-length");
    return new Response(injected, { status: response.status, statusText: response.statusText, headers });
  });
}

self.addEventListener("install", event => { event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).then(response => { const copy=response.clone(); caches.open(CACHE_NAME).then(cache => cache.put("./index.html", copy)); return injectPushModule(response); }).catch(() => caches.match("./index.html").then(injectPushModule)));
    return;
  }
  if (["/push-v1a.js","/push-deeplink-v1d.js","/ui-v1f.css","/ui-v1f.js","/comments-v1.js","/activity-v1.js"].some(suffix => requestUrl.pathname.endsWith(suffix))) {
    event.respondWith(fetch(event.request).then(response => { const copy=response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)); return response; }).catch(() => caches.match(event.request)));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => { const copy=response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)); return response; })));
});
