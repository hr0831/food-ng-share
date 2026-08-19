/**
 * Supabase クライアントの初期化。
 * ここ以外で createClient を呼ばないこと。
 */
import { createClient } from "../vendor/supabase-js.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, IS_CONFIGURED } from "../config.js";

export { IS_CONFIGURED, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY };

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    // 一度ログインしたら当面再ログイン不要にする（localStorage に保存 + 自動更新）
    persistSession: true,
    autoRefreshToken: true,
    // マジックリンクから戻ってきた URL のトークンを自動で取り込む
    detectSessionInUrl: true,
    /*
     * flowType は敢えて implicit（supabase-js の既定）のまま使う。
     * pkce にすると「リンクを送ったブラウザ」と「リンクを開いたブラウザ」が
     * 同一でないとログインできない。スマホではメールアプリの内蔵ブラウザで
     * 開かれることが多く、その場合 pkce だと必ず失敗する。
     * implicit なら別ブラウザで開いてもログインできる。
     */
    flowType: "implicit",
    storageKey: "food-ng-share.auth",
  },
  realtime: {
    // 2人しか使わないので少なくてよい。取りこぼしより負荷抑制を優先。
    params: { eventsPerSecond: 5 },
  },
  global: {
    headers: { "X-Client-Info": "food-ng-share/1.0.0" },
  },
});

/**
 * プロジェクトが一時停止中かどうかを実際に叩いて確かめる。
 * 無料プランは1週間アクセスがないと自動停止し、その状態では API が
 * 540 などを返すか、そもそも接続できない。汎用エラーで済ませず区別するために使う。
 *
 * @returns {Promise<"ok"|"paused"|"offline"|"unknown">}
 */
export async function probeProject() {
  if (!navigator.onLine) return "offline";
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/heartbeat?select=id&limit=1`,
      {
        method: "GET",
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        },
        cache: "no-store",
      }
    );
    if (res.ok) return "ok";
    // Supabase の一時停止プロジェクトはゲートウェイが 540 系を返す
    if (res.status === 540 || res.status === 503 || res.status === 502) return "paused";
    return "unknown";
  } catch {
    // fetch 自体が落ちた = ネットワーク断、または休止でホストが応答しない
    return navigator.onLine ? "paused" : "offline";
  }
}
