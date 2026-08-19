/**
 * ログイン・セッション管理（マジックリンク / メールOTP）。
 *
 * パスワードを持たない方式にしているのは、利用者が2人しかおらず
 * パスワードリセット等のユーザー管理を作り込む価値がないため。
 * 匿名ログインではなくメールにしているのは「誰の登録か」を確実に紐づけるため。
 */
import { supabase } from "./supabase.js";

/*
 * マジックリンクが失敗して戻ってきた場合、URL のフラグメントに
 * #error=...&error_code=otp_expired... が入っている。
 * supabase-js はセッション復元処理の中でこのフラグメントを消してしまうので、
 * モジュール読み込み直後（同期）に横取りして控えておく。
 */
export const linkError = (() => {
  const hash = window.location.hash || "";
  if (!hash.includes("error")) return null;
  const p = new URLSearchParams(hash.slice(1));
  const code = p.get("error_code") || p.get("error") || "";
  if (!code) return null;
  if (code.includes("expired")) {
    return "ログインリンクの有効期限が切れています。もう一度メールを送信してください。";
  }
  return "ログインリンクが無効でした。もう一度メールを送信してください。";
})();

const COOLDOWN_KEY = "food-ng-share.otpCooldownUntil";
const LAST_EMAIL_KEY = "food-ng-share.lastEmail";
const PENDING_INVITE_KEY = "food-ng-share.pendingInvite";

/** 送信ボタンのクールダウン秒数。Supabase 組み込みメールの送信上限対策。 */
export const COOLDOWN_SECONDS = 60;

/** マジックリンクの戻り先。クエリ/ハッシュを落とした「このページ自身」。 */
export function redirectUrl() {
  return window.location.origin + window.location.pathname;
}

/**
 * ホーム画面に追加した「インストール済み」状態で起動しているか。
 *
 * iOS ではホーム画面のWebアプリと Safari で保存領域（localStorage）が
 * 完全に別々になる。メールのマジックリンクをタップすると必ず Safari 側で
 * 開くため、そこでログインが成立してもホーム画面アプリには何も残らず、
 * 毎回ログイン画面に戻ってしまう。
 *
 * この状態では「リンクではなくコードを入力してもらう」しか手がないので、
 * 判定して案内を切り替えるために使う。
 */
export function isStandalone() {
  try {
    return (
      window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
      window.matchMedia?.("(display-mode: fullscreen)")?.matches === true ||
      window.navigator.standalone === true      // iOS Safari の独自プロパティ
    );
  } catch {
    return false;
  }
}

/**
 * 保存領域をブラウザに消されにくくするよう要求する。
 * 対応していない環境では何も起きない（拒否されても実害はない）。
 */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch {
    /* 未対応・拒否。ログインが早めに切れるだけなので握りつぶす */
  }
}

/** 前回入力したメールアドレス（再訪時の入力補助 / OTP 検証に使う） */
export function lastEmail() {
  return localStorage.getItem(LAST_EMAIL_KEY) || "";
}

/**
 * 招待コードは ?invite=XXXX の形で URL に載る。
 * マジックリンクの往復で URL が消えるので、送信前に控えておく。
 */
export function stashPendingInvite(code) {
  if (code) localStorage.setItem(PENDING_INVITE_KEY, code);
}
export function takePendingInvite() {
  const v = localStorage.getItem(PENDING_INVITE_KEY);
  if (v) localStorage.removeItem(PENDING_INVITE_KEY);
  return v;
}

/** クールダウンの残り秒数（0 なら送信可能）。リロードしてもリセットされないよう localStorage に保存。 */
export function cooldownRemaining() {
  const until = Number(localStorage.getItem(COOLDOWN_KEY) || 0);
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}
function startCooldown(seconds = COOLDOWN_SECONDS) {
  localStorage.setItem(COOLDOWN_KEY, String(Date.now() + seconds * 1000));
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) return null;
  return data.session;
}

export function onAuthChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });
  return () => data.subscription.unsubscribe();
}

/**
 * マジックリンク（＋ 確認コード）をメールで送る。
 * @returns {Promise<{ok: true} | {ok: false, message: string}>}
 */
export async function sendMagicLink(email) {
  const trimmed = String(email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { ok: false, message: "メールアドレスの形式が正しくないようです。" };
  }
  const remaining = cooldownRemaining();
  if (remaining > 0) {
    return { ok: false, message: `送信しすぎ防止のため、あと ${remaining} 秒お待ちください。` };
  }

  // 先にクールダウンを始める。ネットワークが遅いときの連打で
  // 何通も送ってしまい上限に当たるのを防ぐため。
  startCooldown();
  localStorage.setItem(LAST_EMAIL_KEY, trimmed);

  const { error } = await supabase.auth.signInWithOtp({
    email: trimmed,
    options: {
      emailRedirectTo: redirectUrl(),
      shouldCreateUser: true, // 2人とも初回はアカウントが無いので必要
    },
  });

  if (error) return { ok: false, message: describeAuthError(error) };
  return { ok: true };
}

/**
 * メールに書かれた確認コードでログインする。
 * 別のブラウザ（メールアプリの内蔵ブラウザ等）でリンクが開いてしまい
 * 戻ってこられない場合や、ホーム画面アプリから使う場合の入口。
 *
 * 桁数を6に決め打ちしないのは、Supabase 側の設定（Email OTP Length）で
 * 6〜10桁の間で変えられるため。設定を変えた瞬間にログインできなくなるのを避ける。
 */
export async function verifyEmailOtp(email, token) {
  const trimmed = String(email || "").trim();
  const code = String(token || "").replace(/\D/g, "");
  if (!trimmed) return { ok: false, message: "メールアドレスを入力してください。" };
  if (code.length < 6 || code.length > 10) {
    return { ok: false, message: "メールに届いた数字のコードをそのまま入力してください。" };
  }

  const { error } = await supabase.auth.verifyOtp({
    email: trimmed,
    token: code,
    type: "email",
  });
  if (error) return { ok: false, message: describeAuthError(error) };
  return { ok: true };
}

export async function signOut() {
  await supabase.auth.signOut();
  localStorage.removeItem(PENDING_INVITE_KEY);
}

/**
 * Supabase Auth のエラーを日本語に翻訳する。
 * 特にメール送信上限は開発中に必ず踏むので、汎用エラーで済ませない。
 */
export function describeAuthError(error) {
  const status = error?.status ?? 0;
  const code = error?.code || "";
  const msg = String(error?.message || "").toLowerCase();

  if (
    status === 429 ||
    code === "over_email_send_rate_limit" ||
    code === "over_request_rate_limit" ||
    msg.includes("rate limit") ||
    msg.includes("you can only request this after")
  ) {
    return (
      "メール送信の上限に達した可能性があります。しばらく待ってから再試行してください。" +
      "（Supabase 組み込みのメール送信には1時間あたりの上限があります）"
    );
  }
  if (code === "otp_expired" || msg.includes("expired")) {
    return "コード／リンクの有効期限が切れています。もう一度メールを送信してください。";
  }
  if (code === "otp_disabled") {
    return "メールログインが無効になっています。Supabase の Authentication 設定を確認してください。";
  }
  if (msg.includes("invalid") && msg.includes("token")) {
    return "コードが違うようです。メールに書かれた数字をもう一度確認してください。";
  }
  if (msg.includes("email address") && msg.includes("invalid")) {
    return "このメールアドレスは受け付けられませんでした。別のアドレスをお試しください。";
  }
  if (msg.includes("failed to fetch") || msg.includes("networkerror")) {
    return "ネットワークに接続できませんでした。通信状況を確認して再試行してください。";
  }
  if (msg.includes("redirect")) {
    return (
      "リダイレクト先URLが許可されていません。Supabase の Authentication > URL Configuration に " +
      `${redirectUrl()} を登録してください。`
    );
  }
  return `ログインに失敗しました（${error?.message || "原因不明"}）。`;
}
