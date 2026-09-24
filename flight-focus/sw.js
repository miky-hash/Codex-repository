/* 포커스 에어 서비스 워커: 비행 중 기기 알림을 띄우고, 알림을 누르면 앱으로 돌아옴 (캐시는 하지 않음) */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow ? self.clients.openWindow('./') : undefined;
  }));
});
