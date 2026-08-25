/**
 * notify-partner — 相手が追加・削除したときにプッシュ通知を送る。
 *
 * このファイルは Supabase ダッシュボードの
 *   Edge Functions > Deploy a new function > Via Editor
 * に貼り付けて使う（PCへのインストールは不要）。
 *
 * 呼ばれ方は2通り:
 *   1) Database Webhook（restrictions の INSERT / DELETE）
 *      → 変更した本人以外のメンバーへ通知する
 *   2) アプリの「テスト通知を送る」ボタン（body が {"test":true}）
 *      → 押した本人へ1通送る。届かないときの切り分け用。
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

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  /* ---------------- テスト送信（アプリのボタンから） ---------------- */
  if (body.test === true) {
    // 呼び出した本人を、渡された JWT から特定する
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    const { data: userData, error } = await admin.auth.getUser(jwt);
    if (error || !userData?.user) {
      return new Response("ログインが確認できませんでした", { status: 401 });
    }
    const uid = userData.user.id;

    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("user_id", uid);

    if (!subs?.length) {
      return new Response("この端末はまだ通知に登録されていません", { status: 404 });
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
      return new Response(
        `送信できませんでした: ${JSON.stringify(failed).slice(0, 300)}`,
        { status: 502 },
      );
    }
    return new Response(`${sent}件の端末へ送信しました`, { status: 200 });
  }

  /* ---------------- Database Webhook からの呼び出し ---------------- */
  if (WEBHOOK_SECRET && req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const type = String(body.type ?? "");
  // 通知するのは「増えた・減った」ときだけ。レベルやメモの微調整では鳴らさない。
  if (type !== "INSERT" && type !== "DELETE") {
    return new Response("skipped", { status: 200 });
  }

  const row = (body.record ?? body.old_record) as Record<string, string> | null;
  if (!row?.room_id || !row?.user_id) return new Response("no row", { status: 200 });

  const actorId = row.user_id;
  const roomId = row.room_id;

  // 同じルームの「本人以外」を宛先にする
  const { data: members } = await admin
    .from("room_members").select("user_id").eq("room_id", roomId);
  const targets = (members ?? []).map((m) => m.user_id).filter((id) => id !== actorId);
  if (!targets.length) return new Response("no partner", { status: 200 });

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("user_id", targets);
  if (!subs?.length) return new Response("no subscriptions", { status: 200 });

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

  return new Response(
    JSON.stringify({ sent: results.filter((r) => r.ok).length, total: results.length }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
