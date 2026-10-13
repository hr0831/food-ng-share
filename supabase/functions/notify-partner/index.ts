/**
 * notify-partner — 相手が追加・削除したときにプッシュ通知を送る。
 *
 * このファイルは Supabase ダッシュボードの
 *   Edge Functions > Deploy a new function > Via Editor
 * に貼り付けて使う（PCへのインストールは不要）。
 *
 * 呼ばれ方は3通り:
 *   1) Database Webhook（restrictions の INSERT / DELETE）
 *      → 変更した本人以外のメンバーへ通知する
 *      ※ source="game"（あそぶタブの仕分け）は DB 側のトリガーで除外済み。
 *        10件まとめて入るので、1件ずつ通知すると10連発になるため。
 *   2) アプリの「テスト通知を送る」ボタン（body が {"test":true}）
 *      → 押した本人へ1通送る。届かないときの切り分け用。
 *   3) 仕分け1セットの終わり（body が {"match":true, "names":[...]}）
 *      → 相手へ「3つ一致しました」を1通だけ送る。
 *
 * 2) と 3) は、どちらも「誰から呼ばれたか」をJWTで確かめる。
 * 宛先はサーバ側で同じルームの相手を引くので、他人へ勝手には送れない。
 *
 * 必要なシークレット（Edge Functions > Secrets に登録）:
 *   VAPID_PUBLIC_KEY   … config.js に書いたものと同じ公開鍵
 *   VAPID_PRIVATE_KEY  … 秘密鍵。絶対に公開しない
 *   VAPID_SUBJECT      … "mailto:あなたのメールアドレス"
 *   WEBHOOK_SECRET     … Database Webhook のヘッダーと突き合わせる合言葉
 *
 * SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY は Supabase が自動で入れてくれる。
 * service_role キーはこの関数の中（サーバ側）だけで使う。フロントには絶対に出さない。
 */
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.58.0";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:example@example.com";
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

/** service_role で動くクライアント。RLS を通り抜けて相手の宛先も引ける。 */
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const KIND_LABEL: Record<string, string> = {
  allergy: "アレルギー",
  dislike: "苦手",
  like: "好きなもの",
};

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };

/*
 * CORS。
 * アプリは https://<ユーザー名>.github.io から、この関数は supabase.co から
 * 配信されるので別ドメイン扱いになる。許可ヘッダーを返さないと、ブラウザは
 * 本番のリクエストを送る前の確認（OPTIONS）で止まり、
 * 画面には理由の分からない "Load failed" だけが出る。
 *
 * 誰でも呼べて困らないのは、この関数自身が
 *   ・DBから  → 合言葉が一致しないと拒否
 *   ・アプリから → ログイン情報を検証して本人確認
 * を必ず行っているため。
 */
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-webhook-secret",
  "Access-Control-Max-Age": "86400",
};

/** CORS ヘッダー付きで返す。すべての応答をこれに通すこと。 */
const reply = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { ...CORS, ...extra } });

/** 宛先1件へ送る。相手が通知を切っていたら宛先を掃除する。 */
async function sendTo(sub: Sub, payload: unknown) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 3600 },
    );
    return { ok: true };
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode;
    // 404/410 は「その宛先はもう無い」の意味。残しておくと毎回失敗するので消す。
    if (status === 404 || status === 410) {
      await admin.from("push_subscriptions").delete().eq("id", sub.id);
      return { ok: false, gone: true };
    }
    return { ok: false, error: String((err as Error)?.message ?? err), status };
  }
}

async function displayName(userId: string) {
  const { data } = await admin
    .from("profiles").select("display_name").eq("id", userId).maybeSingle();
  return data?.display_name || "相手";
}

/** Authorization ヘッダーの JWT から、呼び出した本人を特定する */
async function userIdFrom(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data, error } = await admin.auth.getUser(jwt);
  return error || !data?.user ? null : data.user.id;
}

/** その人が入っているルームの、本人以外のメンバー */
async function partnersOf(userId: string) {
  const { data: mine } = await admin
    .from("room_members").select("room_id").eq("user_id", userId).limit(1).maybeSingle();
  if (!mine?.room_id) return { roomId: null, targets: [] as string[] };

  const { data: members } = await admin
    .from("room_members").select("user_id").eq("room_id", mine.room_id);
  return {
    roomId: mine.room_id as string,
    targets: (members ?? []).map((m) => m.user_id).filter((id) => id !== userId),
  };
}

/** 「たこやき、ほか2つ」の形に縮める（アプリ画面の文面と揃える） */
function summarize(names: string[]) {
  return names.length > 1 ? `${names[0]}、ほか${names.length - 1}つ` : names[0];
}

Deno.serve(async (req) => {
  // ブラウザが本番リクエスト前に投げてくる確認。ここで許可を返さないと先へ進めない
  if (req.method === "OPTIONS") return reply("ok");
  if (req.method !== "POST") return reply("POST only", 405);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return reply("invalid json", 400);
  }

  /* ---------------- テスト送信（アプリのボタンから） ---------------- */
  if (body.test === true) {
    const uid = await userIdFrom(req);
    if (!uid) return reply("ログインが確認できませんでした", 401);

    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("user_id", uid);

    if (!subs?.length) {
      return reply("この端末はまだ通知に登録されていません", 404);
    }

    const results = await Promise.all(subs.map((s) =>
      sendTo(s as Sub, {
        title: "ふたりごはん",
        body: "テスト通知です。これが見えていれば設定は成功です。",
        tag: "futarigohan-test",
      })
    ));
    const sent = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok && !r.gone);
    if (sent === 0) {
      return reply(`送信できませんでした: ${JSON.stringify(failed).slice(0, 300)}`, 502);
    }
    return reply(`${sent}件の端末へ送信しました`, 200);
  }

  /* ------------- 仕分けの一致（1セットにつき1通だけ） ------------- */
  if (body.match === true) {
    const uid = await userIdFrom(req);
    if (!uid) return reply("ログインが確認できませんでした", 401);

    // 文字数と件数は、こちらで必ず切り詰める（長い本文で通知が壊れないように）
    const names: string[] = Array.isArray(body.names)
      ? (body.names as unknown[])
          .filter((n): n is string => typeof n === "string" && n.trim() !== "")
          .slice(0, 20)
          .map((n) => n.slice(0, 40))
      : [];
    if (!names.length) return reply("no names", 200);

    const { roomId, targets } = await partnersOf(uid);
    if (!roomId) return reply("no room", 200);
    if (!targets.length) return reply("no partner", 200);

    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .in("user_id", targets);
    if (!subs?.length) return reply("no subscriptions", 200);

    const who = await displayName(uid);
    const results = await Promise.all(subs.map((s) =>
      sendTo(s as Sub, {
        title: "ふたりごはん",
        body: `${who}さんと${names.length}つ一致しました（${summarize(names)}）`,
        // 同じタグなら新しい方で置き換わる。連投しても通知欄が埋まらない
        tag: `futarigohan-match-${roomId}`,
      })
    ));
    return reply(
      JSON.stringify({ sent: results.filter((r) => r.ok).length, total: results.length }),
      200,
      { "Content-Type": "application/json" },
    );
  }

  /* ---------------- Database Webhook からの呼び出し ---------------- */
  if (WEBHOOK_SECRET && req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return reply("forbidden", 403);
  }

  const type = String(body.type ?? "");
  // 通知するのは「増えた・減った」ときだけ。レベルやメモの微調整では鳴らさない。
  if (type !== "INSERT" && type !== "DELETE") {
    return reply("skipped", 200);
  }

  const row = (body.record ?? body.old_record) as Record<string, string> | null;
  if (!row?.room_id || !row?.user_id) return reply("no row", 200);

  const actorId = row.user_id;
  const roomId = row.room_id;

  // 同じルームの「本人以外」を宛先にする
  const { data: members } = await admin
    .from("room_members").select("user_id").eq("room_id", roomId);
  const targets = (members ?? []).map((m) => m.user_id).filter((id) => id !== actorId);
  if (!targets.length) return reply("no partner", 200);

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("user_id", targets);
  if (!subs?.length) return reply("no subscriptions", 200);

  const who = await displayName(actorId);
  const food = row.food ?? "";
  const kind = KIND_LABEL[row.kind] ?? "リスト";
  const message = type === "INSERT"
    ? `${who}さんが「${food}」を${kind}に追加しました`
    : `${who}さんが「${food}」を削除しました`;

  const results = await Promise.all(subs.map((s) =>
    sendTo(s as Sub, {
      title: "ふたりごはん",
      body: message,
      tag: `futarigohan-${roomId}`,
    })
  ));

  return reply(
    JSON.stringify({ sent: results.filter((r) => r.ok).length, total: results.length }),
    200,
    { "Content-Type": "application/json" },
  );
});
