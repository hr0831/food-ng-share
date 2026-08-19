/**
 * Realtime 購読とプレゼンス。
 *
 * - Postgres Changes で restrictions / profiles の変更を受け取る
 * - Presence で「相手が今開いているか」を出す
 * - 接続状態を UI に返し、再接続できたら再取得（onResync）を促す
 */
import { supabase } from "./supabase.js";

/** @typedef {"connecting"|"online"|"reconnecting"|"offline"} ConnState */

/**
 * ルーム単位のチャンネルを作って購読を開始する。
 *
 * @param {object} opts
 * @param {string} opts.roomId
 * @param {string} opts.userId
 * @param {() => string} opts.getDisplayName  購読中に表示名が変わることがあるので関数で受ける
 * @param {(payload: {eventType: string, new: object|null, old: object|null}) => void} opts.onRestriction
 * @param {(row: object) => void} opts.onProfile
 * @param {() => void} opts.onMembership  相手が参加/退出したとき
 * @param {(others: Array<{user_id: string, display_name: string}>) => void} opts.onPresence
 * @param {(state: ConnState) => void} opts.onState
 * @param {() => void} opts.onResync  再接続直後に最新データを取り直すためのフック
 */
export function subscribeRoom(opts) {
  const {
    roomId,
    userId,
    getDisplayName,
    onRestriction,
    onProfile,
    onMembership,
    onPresence,
    onState,
    onResync,
  } = opts;

  let channel = null;
  let disposed = false;
  let retryAttempt = 0;
  let retryTimer = null;
  let hasBeenOnline = false;
  /** @type {ConnState} */
  let state = "connecting";

  function setState(next) {
    if (state === next) return;
    state = next;
    onState?.(next);
  }

  function clearRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry() {
    if (disposed || retryTimer) return;
    // 1秒 → 2 → 4 … 最大30秒。端末スリープ復帰時に大量再接続しないよう頭打ちにする
    const delay = Math.min(30000, 1000 * 2 ** retryAttempt);
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (disposed) return;
    if (!navigator.onLine) {
      setState("offline");
      return;
    }
    teardownChannel();
    setState(hasBeenOnline ? "reconnecting" : "connecting");

    channel = supabase
      .channel(`room:${roomId}`, {
        config: { presence: { key: userId } },
      })
      // restrictions は room_id でフィルタして必要な行だけ受け取る。
      // DELETE でも room_id が old に入るよう、schema.sql で
      // `replica identity full` を設定してあるのが前提。
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "restrictions", filter: `room_id=eq.${roomId}` },
        (payload) => {
          onRestriction?.({
            eventType: payload.eventType,
            new: payload.new && Object.keys(payload.new).length ? payload.new : null,
            old: payload.old && Object.keys(payload.old).length ? payload.old : null,
          });
        }
      )
      // profiles には room_id が無いのでフィルタできない。
      // RLS（同じルームのメンバーのみ SELECT 可）が効いているため、
      // フィルタ無しでも他人のプロフィールは飛んでこない。
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "profiles" },
        (payload) => {
          if (payload.new && payload.new.id) onProfile?.(payload.new);
        }
      )
      // 相手が参加/退出した瞬間に気づくため。これが無いと、招待コードで
      // 相手が入っても「相手のリスト」タブが招待画面のまま固まる。
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_members", filter: `room_id=eq.${roomId}` },
        () => onMembership?.()
      )
      .on("presence", { event: "sync" }, () => {
        const raw = channel.presenceState();
        const others = [];
        for (const [key, metas] of Object.entries(raw)) {
          if (key === userId) continue;
          const meta = metas?.[0] || {};
          others.push({ user_id: key, display_name: meta.display_name || "相手" });
        }
        onPresence?.(others);
      })
      .subscribe(async (status) => {
        if (disposed) return;
        if (status === "SUBSCRIBED") {
          retryAttempt = 0;
          clearRetry();
          const wasReconnect = hasBeenOnline;
          hasBeenOnline = true;
          setState("online");
          await channel.track({
            user_id: userId,
            display_name: getDisplayName?.() || "",
            online_at: new Date().toISOString(),
          });
          // 切断中に相手が加えた変更はイベントとして受け取れていないので取り直す
          if (wasReconnect) onResync?.();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setState(navigator.onLine ? "reconnecting" : "offline");
          scheduleRetry();
        }
      });
  }

  function teardownChannel() {
    if (channel) {
      try {
        supabase.removeChannel(channel);
      } catch {
        /* 既に破棄済みなら無視 */
      }
      channel = null;
    }
  }

  /** 表示名を変えたときにプレゼンスへ反映する */
  async function refreshPresence() {
    if (!channel || state !== "online") return;
    try {
      await channel.track({
        user_id: userId,
        display_name: getDisplayName?.() || "",
        online_at: new Date().toISOString(),
      });
    } catch {
      /* 失敗しても表示が古いだけなので握りつぶす */
    }
  }

  const handleOnline = () => {
    retryAttempt = 0;
    clearRetry();
    connect();
    // ソケットが戻る前でも HTTP は通ることがあるので、先に一度取り直す
    onResync?.();
  };
  const handleOffline = () => {
    clearRetry();
    setState("offline");
  };
  const handleVisibility = () => {
    // iOS Safari はバックグラウンドで WebSocket を切る。復帰時に必ず整合を取る。
    if (document.visibilityState === "visible") {
      if (!navigator.onLine) return setState("offline");
      if (state !== "online") connect();
      onResync?.();
    }
  };

  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);
  document.addEventListener("visibilitychange", handleVisibility);

  connect();

  return {
    refreshPresence,
    getState: () => state,
    dispose() {
      disposed = true;
      clearRetry();
      teardownChannel();
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibility);
    },
  };
}
