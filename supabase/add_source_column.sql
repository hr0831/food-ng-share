-- =====================================================================
--  「あそぶ」タブ（仕分けゲーム）を入れるための追加。
--
--  やること
--    1. restrictions に source 列（手入力 / 仕分け）を足す
--    2. 通知のトリガーに「仕分けで入ったものは送らない」を足す
--
--  なぜ必要か
--    仕分けは1セットで10件が一度に登録される。今のままだと
--    「相手が追加しました」の通知が10連発で飛んでしまう。
--    一致の知らせは、アプリがセットの終わりに1通だけ送る仕組みに分けてある。
--
--  既存のデータへの影響
--    既存の行はすべて source='manual'（手入力）になる。
--    通知の挙動も今までどおり。RLS もポリシーも変更しない。
--
--  実行する場所
--    Supabase ダッシュボード > SQL Editor に貼り付けて Run。
--    何度実行しても同じ結果になる（再実行して構わない）。
--
--  ★先に supabase/notify_trigger.sql を実行済みであること★
--    （この中で、そこで作った関数を作り直している）
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. source 列
-- ---------------------------------------------------------------------
alter table public.restrictions
  add column if not exists source text not null default 'manual';

-- 制約は貼り直す（すでに同名のものがあっても落ちないように）
alter table public.restrictions drop constraint if exists restrictions_source_check;
alter table public.restrictions
  add constraint restrictions_source_check check (source in ('manual', 'game'));


-- ---------------------------------------------------------------------
-- 2. 通知トリガーの作り直し
--
--    中身は notify_trigger.sql と同じで、冒頭の「仕分けなら何もしない」
--    判定だけが増えている。設定（URLと合言葉）はそのまま使うので、
--    合言葉を入れ直す必要はない。
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
   * 「あそぶ」タブの仕分けで入ったもの・消したものは通知しない。
   * 1セットで10件が一度に動くため、ここで止めないと通知が10連発になる。
   */
  if tg_op = 'INSERT' and new.source = 'game' then
    return null;
  end if;
  if tg_op = 'DELETE' and old.source = 'game' then
    return null;
  end if;

  select value into v_url    from app_private.settings where key = 'notify_url';
  select value into v_secret from app_private.settings where key = 'webhook_secret';
  if v_url is null or v_url = '' then
    return null;
  end if;

  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;

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

revoke all on function app_private.notify_partner_change() from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 3. 確認用
--
--    Supabase の SQL Editor は「最後に行を返した文」の結果しか表示しない。
--    確認したい表は必ず一番下に置くこと。
-- ---------------------------------------------------------------------
select
  '列'                                                      as 種別,
  'restrictions.source'                                     as 名前,
  case when exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'restrictions'
      and column_name  = 'source'
  ) then '追加されました' else '❌ ありません' end           as 状態

union all

select
  '手入力の件数',
  'source = manual',
  count(*)::text
from public.restrictions where source = 'manual'

union all

select
  '仕分けの件数',
  'source = game',
  count(*)::text
from public.restrictions where source = 'game'

union all

select
  'トリガー',
  tgname,
  case when tgenabled = 'O' then '有効' else '無効' end
from pg_trigger
where tgrelid = 'public.restrictions'::regclass
  and tgname = 'restrictions_notify_partner';
