/**
 * Service Worker（プッシュ通知の受け取り専用）。
 *
 * ★ fetch イベントを一切扱わない ★
 *   ページやJSをキャッシュする作りにすると、更新したのに古い画面が出続ける
 *   という厄介な事故が起きる。このアプリは更新のたびにファイルを差し替える
 *   運用なので、オフライン対応より「常に最新が出ること」を優先している。
 *   ここは通知を受け取るためだけに置いている。
 */

// 新しい sw.js を置いたら、待たずに即座に入れ替える
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "ふたりごはん";
  const options = {
    body: data.body || "リストが更新されました",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    // 同じ話題の通知は積み上げず1件にまとめる（連続登録で埋まらないように）
    tag: data.tag || "futarigohan-update",
    renotify: true,
    data: { url: data.url || "./" },
  };

  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    /*
     * アイコンのバッジ。件数の管理は Service Worker が落とされると失われるので、
     * 数を持たずに「点」だけ付ける。数字より確実で、アプリを開けば消える。
     */
    try {
      if (self.navigator && self.navigator.setAppBadge) await self.navigator.setAppBadge();
    } catch {
      /* 未対応環境。通知本体は出ているので問題ない */
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || "./", self.registration.scope).href;
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // 既に開いているタブがあればそれを前面に出す（二重に開かない）
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

/*
 * ブラウザ側の都合で購読が作り直されることがある。
 * 放置すると通知が届かなくなるので、アプリ側へ「取り直して」と伝える。
 * （アプリが開かれた時にも毎回登録し直すので、これは保険）
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) w.postMessage({ type: "resubscribe-push" });
  })());
});
