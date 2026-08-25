/**
 * プッシュ通知の購読管理。
 *
 * 仕組み:
 *   1. Service Worker を登録する（sw.js）
 *   2. 通知の許可をもらう
 *   3. ブラウザから購読情報（宛先）をもらい、push_subscriptions に保存する
 *   4. 相手が追加・削除すると Supabase の Webhook が Edge Function を呼び、
 *      そこからこの宛先へ通知が飛ぶ
 *
 * iOS の注意:
 *   ホーム画面に追加した状態でしか通知は使えない。
 *   また許可を求めるダイアログは「利用者のタップの中でしか」出せないため、
 *   enablePush() は必ずボタンの click ハンドラから直接呼ぶこと。
 */
import { supabase, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase.js";
import { VAPID_PUBLIC_KEY } from "../config.js";
import { isStandalone } from "./auth.js";

/** base64url の公開鍵を、購読APIが要求するバイト列に変換する */
function urlBase64ToUint8Array(base64) {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

const b64 = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** この環境でプッシュ通知が使えるか */
export function pushSupported() {
  return Boolean(
    VAPID_PUBLIC_KEY &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * 使えない理由を日本語で返す（使える場合は null）。
 * 「なぜかボタンが出ない」で悩まないよう、理由を必ず画面に出すために使う。
 */
export function unsupportedReason() {
  if (!VAPID_PUBLIC_KEY) return "通知用のカギ（VAPID_PUBLIC_KEY）が config.js に設定されていません。";
  if (!("serviceWorker" in navigator)) return "このブラウザは通知に対応していません。";
  if (!("PushManager" in window) || !("Notification" in window)) {
    // iOS でホーム画面に追加していない場合がまさにこれ
    return isIos() && !isStandalone()
      ? "iPhone / iPad では、ホーム画面に追加したアイコンから開いたときだけ通知を使えます。"
      : "このブラウザは通知に対応していません。";
  }
  if (isIos() && !isStandalone()) {
    return "iPhone / iPad では、ホーム画面に追加したアイコンから開いてください。";
  }
  return null;
}

function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** 現在の許可状態: "default" | "granted" | "denied" */
export function permission() {
  return "Notification" in window ? Notification.permission : "denied";
}

let swReady = null;
/** Service Worker を登録して使える状態にする */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  if (!swReady) {
    swReady = navigator.serviceWorker
      .register("./sw.js")
      .then(() => navigator.serviceWorker.ready)
      .catch(() => null);
  }
  return swReady;
}

/** アイコンのバッジ（点）を消す。アプリを開いた時点で既読とみなす。 */
export async function clearBadge() {
  try {
    if (navigator.clearAppBadge) await navigator.clearAppBadge();
  } catch {
    /* 未対応なら何もしなくてよい */
  }
}

/**
 * 通知を有効にする。
 * @returns {Promise<{ok:true} | {ok:false, message:string}>}
 */
export async function enablePush(userId, roomId) {
  const reason = unsupportedReason();
  if (reason) return { ok: false, message: reason };

  const reg = await registerServiceWorker();
  if (!reg) return { ok: false, message: "通知の準備に失敗しました（Service Worker を登録できません）。" };

  // 許可ダイアログ。iOS ではタップの流れの中でしか開かない
  let perm = permission();
  if (perm === "default") perm = await Notification.requestPermission();
  if (perm === "denied") {
    return {
      ok: false,
      message: "通知がブロックされています。端末の設定＞通知 から、このアプリの通知を許可してください。",
    };
  }
  if (perm !== "granted") return { ok: false, message: "通知が許可されませんでした。" };

  let sub;
  try {
    sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
  } catch (e) {
    return { ok: false, message: `通知の登録に失敗しました（${e?.message || "原因不明"}）。` };
  }

  const raw = sub.toJSON?.() || {};
  const keys = raw.keys || {
    p256dh: b64(sub.getKey("p256dh")),
    auth: b64(sub.getKey("auth")),
  };

  // 同じ端末で登録し直しても増えないよう endpoint で上書きする
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: userId,
      room_id: roomId,
      endpoint: sub.endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      user_agent: navigator.userAgent.slice(0, 200),
    },
    { onConflict: "endpoint" }
  );
  if (error) {
    return {
      ok: false,
      message: `通知の宛先を保存できませんでした（${error.message}）。schema.sql を実行済みか確認してください。`,
    };
  }
  return { ok: true };
}

/** 通知を無効にする（この端末の宛先だけ消す） */
export async function disablePush() {
  const reg = await registerServiceWorker();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    try {
      await sub.unsubscribe();
    } catch {
      /* 既に解除済みでも構わない */
    }
  }
  await clearBadge();
  return { ok: true };
}

/** この端末が登録済みかどうか */
export async function isEnabled() {
  if (!pushSupported() || permission() !== "granted") return false;
  const reg = await registerServiceWorker();
  if (!reg) return false;
  return Boolean(await reg.pushManager.getSubscription());
}

/**
 * テスト通知。
 * スマホでは開発者ツールが使えず「届かない」原因を切り分けにくいので、
 * 相手の操作を待たずに自分宛てへ1通送れるようにしている。
 */
export async function sendTestPush() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) return { ok: false, message: "ログインが切れています。もう一度ログインしてください。" };

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/notify-partner`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ test: true }),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, message: `テスト送信に失敗しました（HTTP ${res.status}）: ${text.slice(0, 200)}` };
    }
    return { ok: true, message: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, message: `テスト送信に失敗しました（${e?.message || "通信エラー"}）。` };
  }
}
