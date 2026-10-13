-- =====================================================================
--  相手の追加・削除を Edge Function に知らせるトリガー
--
--  Supabase の「Database Webhooks」が使えないプロジェクト向け。
--  （内部スキーマ supabase_functions が用意されていないと
--    "schema supabase_functions does not exist" で作成に失敗する）
--
--  Webhook がやっていることを、自前のトリガー＋pg_net で同じように行う。
--  やることは同じなので、Webhook 機能は使わなくてよい。
--
--  ★実行する前に、下の「ここに③の合言葉」を書き換えてください★
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. DB から外部へ HTTP を投げるための拡張
-- ---------------------------------------------------------------------
create extension if not exists pg_net;


-- ---------------------------------------------------------------------
-- 2. 設定の置き場所
--
--    合言葉をトリガー関数の中に直接書くと、関数の中身は誰でも読めるため
--    ログイン中の利用者に見えてしまう。専用スキーマのテーブルに逃がし、
--    そこへの権限を全部落としておく。
--    public 以外のスキーマは API からも見えないので二重に安全。
-- ---------------------------------------------------------------------
create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

create table if not exists app_private.settings (
  key   text primary key,
  value text not null
);
revoke all on table app_private.settings from public, anon, authenticated;

/*
 * RLS を有効にする（ポリシーは1つも作らない＝誰も読めない）。
 * schema への権限も落としてあるので二重の守り。
 * トリガー関数は security definer で所有者権限で動くため、
 * force は付けない限り所有者は素通りでき、通知は問題なく動く。
 */
alter table app_private.settings enable row level security;

insert into app_private.settings (key, value) values
  ('notify_url',
   'https://habksqmojofyceswcrkm.supabase.co/functions/v1/notify-partner'),
  ('webhook_secret',
   'ここに③の合言葉')                                   -- ★ここを書き換える★
on conflict (key) do update set value = excluded.value;


-- ---------------------------------------------------------------------
-- 3. 変更を Edge Function に投げる関数
--
--    Supabase の Webhook が送るのと同じ形の JSON を作る。
--    （type / record / old_record）Edge Function 側は無改造で動く。
-- ---------------------------------------------------------------------
create or replace function app_private.notify_partner_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
  v_row    jsonb;
begin
  /*
   * 「あそぶ」タブの仕分けで入ったものは通知しない。
   * 1セットで10件が一度に入るので、ここで止めないと相手の端末で
   * 通知が10連発になる。一致の知らせは、アプリがセットの終わりに
   * Edge Function を直接呼んで「まとめて1通」だけ送っている。
   */
  if tg_op = 'INSERT' and new.source = 'game' then
    return null;
  end if;
  if tg_op = 'DELETE' and old.source = 'game' then
    return null;
  end if;

  select value into v_url    from app_private.settings where key = 'notify_url';
  select value into v_secret from app_private.settings where key = 'webhook_secret';
  -- 設定が無ければ何もしない（通知が飛ばないだけで、登録自体は成功させる）
  if v_url is null or v_url = '' then
    return null;
  end if;

  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;

  /*
   * net.http_post は非同期。通知サーバが遅くても、
   * 食材の登録・削除そのものが待たされることはない。
   */
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',     'application/json',
                 'x-webhook-secret', coalesce(v_secret, '')
               ),
    body    := jsonb_build_object(
                 'type',       tg_op,
                 'table',      'restrictions',
                 'schema',     'public',
                 'record',     case when tg_op = 'DELETE' then null else v_row end,
                 'old_record', case when tg_op = 'DELETE' then v_row else null end
               )
  );
  return null;
end;
$$;

-- 直接呼び出せる必要は無い（トリガーからしか使わない）
revoke all on function app_private.notify_partner_change() from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 4. トリガー本体
--    通知するのは「増えた・減った」ときだけ。
--    レベルやメモの修正（UPDATE）では鳴らさない。
-- ---------------------------------------------------------------------
drop trigger if exists restrictions_notify_partner on public.restrictions;
create trigger restrictions_notify_partner
  after insert or delete on public.restrictions
  for each row execute function app_private.notify_partner_change();


-- ---------------------------------------------------------------------
-- 5. 確認用
-- ---------------------------------------------------------------------
select
  'トリガー' as 種別,
  tgname     as 名前,
  case when tgenabled = 'O' then '有効' else '無効' end as 状態
from pg_trigger
where tgrelid = 'public.restrictions'::regclass
  and tgname = 'restrictions_notify_partner'

union all

select
  '設定',
  key,
  case
    when key = 'webhook_secret' and value = 'ここに③の合言葉'
      then '❌ 合言葉が未設定のままです'
    when key = 'webhook_secret'
      then '登録済み（' || length(value) || '文字）'
    else value
  end
from app_private.settings;
