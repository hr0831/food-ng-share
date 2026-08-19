/**
 * DB 操作の集約点。
 * UI（ui.js）からは Supabase を直接触らず、必ずこのモジュール経由で呼ぶ。
 * こうしておくと、エラーの日本語化やリトライの入れどころが1か所で済む。
 */
import { supabase, probeProject } from "./supabase.js";

/* ------------------------------------------------------------------ *
 * 定数（UI と共有するラベル）
 * ------------------------------------------------------------------ */

export const KINDS = {
  allergy: { label: "アレルギー", short: "アレルギー", icon: "⚠️", order: 0 },
  belief: { label: "宗教・信条", short: "宗教・信条", icon: "🕊️", order: 1 },
  dislike: { label: "苦手・好み", short: "苦手", icon: "🥄", order: 2 },
};

export const LEVELS = {
  never: { label: "絶対NG", order: 0 },
  avoid: { label: "できれば避けたい", order: 1 },
  small_ok: { label: "少量なら大丈夫", order: 2 },
};

/* ------------------------------------------------------------------ *
 * エラーの日本語化
 * ------------------------------------------------------------------ */

/** RPC が raise exception で返す識別子 → 日本語 */
const RPC_MESSAGES = {
  AUTH_REQUIRED: "ログインが切れているようです。もう一度ログインしてください。",
  INVALID_CODE: "その招待コードは見つかりませんでした。入力を確認してください。",
  CODE_REVOKED: "この招待コードは無効化されています。相手に再発行してもらってください。",
  ROOM_FULL: "このルームは既に2人います。3人目は参加できません。",
  ALREADY_IN_ROOM: "すでに別のルームに参加しています。先に退出してください。",
  NOT_A_MEMBER: "このルームのメンバーではありません。",
};

/**
 * Supabase / PostgREST のエラーを、利用者に見せられる日本語にする。
 * 「サーバー休止」だけは汎用エラーと明確に区別する必要があるため、
 * ネットワーク系のエラーでは実際にプロジェクトを叩いて判定する。
 *
 * @returns {Promise<{message: string, kind: "paused"|"offline"|"auth"|"denied"|"generic"}>}
 */
export async function describeDbError(error) {
  const msg = String(error?.message || "");
  const code = error?.code || "";

  if (RPC_MESSAGES[msg]) {
    const kind = msg === "AUTH_REQUIRED" ? "auth" : "denied";
    return { message: RPC_MESSAGES[msg], kind };
  }

  // RLS 違反（他人の行を書き換えようとした等）
  if (code === "42501" || msg.includes("row-level security")) {
    return {
      message: "この操作は許可されていません。自分が登録した項目だけ編集・削除できます。",
      kind: "denied",
    };
  }
  if (code === "23505") {
    return { message: "同じ内容が既に登録されています。", kind: "generic" };
  }
  if (code === "PGRST301" || error?.status === 401) {
    return { message: "ログインが切れています。もう一度ログインしてください。", kind: "auth" };
  }

  // ネットワーク層で落ちている場合のみ、休止/オフラインを切り分ける
  const looksNetwork =
    msg.toLowerCase().includes("failed to fetch") ||
    msg.toLowerCase().includes("networkerror") ||
    msg.toLowerCase().includes("load failed") ||
    error?.status === 540 ||
    error?.status === 503;

  if (looksNetwork) {
    const state = await probeProject();
    if (state === "offline") {
      return { message: "オフラインのようです。通信状況を確認してください。", kind: "offline" };
    }
    if (state === "paused") {
      return {
        message:
          "サーバーが休止しています。Supabase ダッシュボードを開いて「Restore project」で復元してください。" +
          "（無料プランは1週間アクセスが無いと自動的に一時停止します）",
        kind: "paused",
      };
    }
    return { message: "サーバーに接続できませんでした。少し待って再試行してください。", kind: "generic" };
  }

  return { message: `エラーが発生しました（${msg || "原因不明"}）。`, kind: "generic" };
}

/** Supabase レスポンスの共通処理。エラーならそのまま throw する。 */
function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

/**
 * UUID を生成する。
 * crypto.randomUUID は secure context 限定なので、file:// で開いた場合など
 * 使えない環境向けに getRandomValues ベースの代替を用意しておく。
 */
export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ------------------------------------------------------------------ *
 * プロフィール
 * ------------------------------------------------------------------ */

/**
 * 自分の profiles 行を確実に存在させる。
 * auth.users への trigger は所有者権限が要りセットアップが壊れやすいので、
 * アプリ側で upsert する方式にしている（RLS の insert ポリシーは自分の行のみ許可）。
 */
export async function ensureProfile(user) {
  const fallbackName = (user.email || "").split("@")[0] || "ゲスト";
  const existing = unwrap(
    await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle()
  );
  if (existing) return existing;

  return unwrap(
    await supabase
      .from("profiles")
      .insert({ id: user.id, display_name: fallbackName })
      .select()
      .single()
  );
}

export async function updateDisplayName(userId, name) {
  const clean = String(name || "").trim().slice(0, 20) || "ゲスト";
  return unwrap(
    await supabase
      .from("profiles")
      .update({ display_name: clean })
      .eq("id", userId)
      .select()
      .single()
  );
}

/** ルーム内メンバーのプロフィールをまとめて取得（RLS で同室の人だけ返る） */
export async function fetchProfiles(userIds) {
  if (!userIds.length) return [];
  return unwrap(await supabase.from("profiles").select("*").in("id", userIds));
}

/* ------------------------------------------------------------------ *
 * ルーム
 * ------------------------------------------------------------------ */

/**
 * 自分が所属するルームと、そのメンバー一覧を取得する。
 * 未所属なら null。
 */
export async function fetchMyRoom() {
  const rooms = unwrap(await supabase.from("rooms").select("*").limit(1));
  // rooms の SELECT は RLS でメンバーのルームだけに絞られているので、
  // 素直に取ると自分のルームだけが返る。
  const room = rooms?.[0];
  if (!room) return null;

  const members = unwrap(
    await supabase.from("room_members").select("*").eq("room_id", room.id)
  );
  return { room, members };
}

export async function createRoom(name = "") {
  return unwrap(await supabase.rpc("create_room", { room_name: name }));
}

export async function joinRoom(code) {
  return unwrap(await supabase.rpc("join_room", { code: String(code || "").trim() }));
}

export async function revokeInvite(roomId) {
  return unwrap(await supabase.rpc("revoke_invite", { p_room_id: roomId }));
}

export async function regenerateInvite(roomId) {
  return unwrap(await supabase.rpc("regenerate_invite", { p_room_id: roomId }));
}

/** 自分だけルームから抜ける（相手は追い出せない） */
export async function leaveRoom(roomId, userId) {
  return unwrap(
    await supabase.from("room_members").delete().eq("room_id", roomId).eq("user_id", userId)
  );
}

/* ------------------------------------------------------------------ *
 * 食べられないもの（restrictions）
 * ------------------------------------------------------------------ */

export async function listRestrictions(roomId) {
  return unwrap(
    await supabase
      .from("restrictions")
      .select("*")
      .eq("room_id", roomId)
      .order("created_at", { ascending: true })
  );
}

/**
 * 追加。
 * id をクライアント側で採番しているのが肝。
 * 楽観的に画面へ出した行とサーバに入る行の id が最初から一致するので、
 * Realtime のエコーが HTTP レスポンスより先に届いても、
 * 「id でマージする」だけで重複表示が起きない（冪等になる）。
 */
export async function addRestriction({ id, roomId, userId, food, kind, level, note }) {
  const row = {
    id: id || newId(),
    room_id: roomId,
    user_id: userId,
    food: String(food).trim().slice(0, 40),
    kind,
    level,
    note: String(note || "").trim().slice(0, 120),
  };
  return unwrap(await supabase.from("restrictions").insert(row).select().single());
}

export async function updateRestriction(id, patch) {
  const clean = {};
  if (patch.food !== undefined) clean.food = String(patch.food).trim().slice(0, 40);
  if (patch.kind !== undefined) clean.kind = patch.kind;
  if (patch.level !== undefined) clean.level = patch.level;
  if (patch.note !== undefined) clean.note = String(patch.note || "").trim().slice(0, 120);
  return unwrap(
    await supabase.from("restrictions").update(clean).eq("id", id).select().single()
  );
}

export async function deleteRestriction(id) {
  return unwrap(await supabase.from("restrictions").delete().eq("id", id));
}

/** 「元に戻す」用。削除前の行をそのまま（id ごと）復活させる。 */
export async function restoreRestriction(row) {
  const { id, room_id, user_id, food, kind, level, note, created_at } = row;
  return unwrap(
    await supabase
      .from("restrictions")
      .insert({ id, room_id, user_id, food, kind, level, note, created_at })
      .select()
      .single()
  );
}
