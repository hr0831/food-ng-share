-- =====================================================================
--  食べられないもの共有アプリ / スキーマ定義
--  Supabase ダッシュボード > SQL Editor にこのファイルの中身を全部貼って
--  「Run」を1回押すだけで完了します。何度実行しても同じ結果になります（冪等）。
-- =====================================================================
--
--  設計の前提:
--    publishable キー（sb_publishable_...）はブラウザに露出する。
--    したがって「RLS だけが唯一のアクセス制御」である。
--    全テーブルで RLS を有効にし、ポリシーが無い操作は暗黙的に拒否される状態にする。
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. 拡張
-- ---------------------------------------------------------------------
-- gen_random_uuid() は PostgreSQL 13 以降の組み込み関数（pg_catalog）なので
-- pgcrypto は不要。Supabase では既定で有効だが、念のため明示しておく。
create extension if not exists pgcrypto with schema extensions;


-- ---------------------------------------------------------------------
-- 1. テーブル
-- ---------------------------------------------------------------------

-- プロフィール（表示名。まとめ画面の「誰のNGか」バッジに使う）
create table if not exists public.profiles (
  id           uuid        primary key references auth.users(id) on delete cascade,
  display_name text        not null default '',
  updated_at   timestamptz not null default now()
);

-- 共有グループ（2人のペア）
create table if not exists public.rooms (
  id                uuid        primary key default gen_random_uuid(),
  name              text        not null default '',
  invite_code       text        unique not null,   -- 推測困難な英数字
  created_by        uuid        not null references auth.users(id),
  created_at        timestamptz not null default now(),
  -- 招待コードの無効化用。null = 有効 / 値あり = 無効化済み。
  -- コード自体を消さずにフラグで無効化するのは、unique not null 制約を保ったまま
  -- 「あとから再発行」もできるようにするため。
  invite_revoked_at timestamptz
);

-- 招待コードを無効化する列は後から足すこともあるので、既存環境向けに補正
alter table public.rooms add column if not exists invite_revoked_at timestamptz;

create table if not exists public.room_members (
  room_id   uuid        not null references public.rooms(id)   on delete cascade,
  user_id   uuid        not null references auth.users(id)     on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

-- 食べられないもの
create table if not exists public.restrictions (
  id         uuid        primary key default gen_random_uuid(),
  room_id    uuid        not null references public.rooms(id) on delete cascade,
  user_id    uuid        not null references auth.users(id)   on delete cascade,
  food       text        not null,
  -- allergy = アレルギー / belief = 宗教・信条 / dislike = 苦手・好み
  kind       text        not null check (kind  in ('allergy', 'belief', 'dislike')),
  -- never = 絶対NG / avoid = できれば避けたい / small_ok = 少量なら大丈夫
  level      text        not null check (level in ('never', 'avoid', 'small_ok')),
  note       text        not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 無料枠の自動停止対策（GitHub Actions から1日1回 GET するだけの的）
create table if not exists public.heartbeat (
  id        bigserial   primary key,
  pinged_at timestamptz not null default now()
);

-- GET したときに空配列ではなく行が返るよう、1行だけ用意しておく
insert into public.heartbeat (pinged_at)
select now()
where not exists (select 1 from public.heartbeat);


-- ---------------------------------------------------------------------
-- 2. インデックス
-- ---------------------------------------------------------------------
-- 一覧取得は必ず room_id で絞る。相手/自分の切り分けは (room_id, user_id)。
create index if not exists restrictions_room_id_idx
  on public.restrictions (room_id);
create index if not exists restrictions_room_id_user_id_idx
  on public.restrictions (room_id, user_id);
create index if not exists room_members_user_id_idx
  on public.room_members (user_id);


-- ---------------------------------------------------------------------
-- 3. updated_at 自動更新トリガー
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists restrictions_touch_updated_at on public.restrictions;
create trigger restrictions_touch_updated_at
  before update on public.restrictions
  for each row execute function public.touch_updated_at();

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------
-- 4. RLS ヘルパー関数
-- ---------------------------------------------------------------------
--
--  ★重要★
--  room_members のポリシーの中で room_members を直接 select すると、
--  そのサブクエリにも RLS が適用されて「ポリシーがポリシーを呼ぶ」無限再帰
--  （42P17: infinite recursion detected in policy for relation "room_members"）
--  になる。
--  security definer 関数は定義者（postgres）の権限で走り RLS を迂回するので、
--  再帰が起きない。security definer には search_path 乗っ取り対策として
--  必ず `set search_path = ''` を付け、全オブジェクトをスキーマ修飾する。
--
create or replace function public.is_room_member(target_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_members m
    where m.room_id = target_room_id
      and m.user_id = (select auth.uid())
  );
$$;

-- 「自分と同じルームに居る相手か？」= profiles の閲覧可否判定に使う
create or replace function public.shares_room_with(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_members me
    join public.room_members other on other.room_id = me.room_id
    where me.user_id = (select auth.uid())
      and other.user_id = target_user_id
  );
$$;


-- ---------------------------------------------------------------------
-- 5. 招待コード生成 / ルーム作成・参加 RPC
-- ---------------------------------------------------------------------

-- gen_random_uuid() は暗号論的に強い乱数源（pg_strong_random）。
-- そのうち 10 桁を大文字16進で使う（約 1.1 兆通り）。
-- 16進なので O / I / l といった紛らわしい「文字」は出てこない。
create or replace function public.generate_invite_code()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    exit when not exists (select 1 from public.rooms r where r.invite_code = v_code);
  end loop;
  return v_code;
end;
$$;

-- ルーム作成。作成者を room_members に入れるところまで一気にやる。
-- テーブルへの直接 INSERT ポリシーを一切作らずに済むので、権限の穴が生まれにくい。
create or replace function public.create_room(room_name text default '')
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_room public.rooms%rowtype;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  -- 1人1ルームまで（このアプリは2人ペア専用なので複数ルームは持たせない）
  if exists (select 1 from public.room_members m where m.user_id = v_uid) then
    raise exception 'ALREADY_IN_ROOM' using errcode = 'P0004';
  end if;

  insert into public.rooms (name, invite_code, created_by)
  values (coalesce(nullif(btrim(room_name), ''), 'わたしたちのNGリスト'),
          public.generate_invite_code(),
          v_uid)
  returning * into v_room;

  insert into public.room_members (room_id, user_id)
  values (v_room.id, v_uid);

  return v_room;
end;
$$;

-- 招待コードで参加する。
-- 「コードを知っていれば自分だけを room_members に足せる」という限定権限を
-- この関数の形で切り出している。テーブルに INSERT ポリシーは付けない。
create or replace function public.join_room(code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_room  public.rooms%rowtype;
  v_code  text;
  v_count int;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  -- 手入力・コピペのゆらぎを吸収する（全角空白、小文字、O/I/L の打ち間違い）
  v_code := upper(btrim(replace(code, '　', '')));
  v_code := translate(v_code, 'OIL', '011');

  -- for update でルーム行をロックし、2人同時参加で上限を超えるのを防ぐ
  select * into v_room from public.rooms r where r.invite_code = v_code for update;
  if not found then
    raise exception 'INVALID_CODE' using errcode = 'P0002';
  end if;

  if v_room.invite_revoked_at is not null then
    raise exception 'CODE_REVOKED' using errcode = 'P0003';
  end if;

  -- 招待リンクを二度踏んでもエラーにしない（既にメンバーなら成功扱い）
  if exists (select 1
             from public.room_members m
             where m.room_id = v_room.id and m.user_id = v_uid) then
    return v_room.id;
  end if;

  if exists (select 1 from public.room_members m where m.user_id = v_uid) then
    raise exception 'ALREADY_IN_ROOM' using errcode = 'P0004';
  end if;

  select count(*) into v_count
  from public.room_members m
  where m.room_id = v_room.id;

  if v_count >= 2 then
    raise exception 'ROOM_FULL' using errcode = 'P0001';
  end if;

  insert into public.room_members (room_id, user_id) values (v_room.id, v_uid);
  return v_room.id;
end;
$$;

-- 招待コードの無効化
create or replace function public.revoke_invite(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_room_member(p_room_id) then
    raise exception 'NOT_A_MEMBER' using errcode = '42501';
  end if;
  update public.rooms set invite_revoked_at = now() where id = p_room_id;
end;
$$;

-- 招待コードの再発行（無効化したあとにもう一度招待したくなった場合）
create or replace function public.regenerate_invite(p_room_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  if not public.is_room_member(p_room_id) then
    raise exception 'NOT_A_MEMBER' using errcode = '42501';
  end if;
  v_code := public.generate_invite_code();
  update public.rooms
     set invite_code = v_code, invite_revoked_at = null
   where id = p_room_id;
  return v_code;
end;
$$;


-- ---------------------------------------------------------------------
-- 6. RLS 有効化
-- ---------------------------------------------------------------------
alter table public.profiles     enable row level security;
alter table public.rooms        enable row level security;
alter table public.room_members enable row level security;
alter table public.restrictions enable row level security;
alter table public.heartbeat    enable row level security;

-- 注: `force row level security`（所有者にも RLS を適用）は敢えて付けない。
-- 付けると SQL Editor / Table Editor（postgres ロールで接続）からも自分のデータが
-- 一切見えなくなり、マイグレーションや調査ができなくなる。
-- アプリは必ず anon / authenticated ロールで接続するため、防御としては
-- enable だけで足りる。


-- ---------------------------------------------------------------------
-- 7. ポリシー
-- ---------------------------------------------------------------------
-- 何度実行しても良いように、まず既存の同名ポリシーを落としてから作る。
--
-- 注: publishable キーでのアクセスは、Postgres 上では従来どおり
--     未ログイン = anon ロール / ログイン後 = authenticated ロール として扱われる。
--     キー名称が変わってもロール名は変わらないので、ポリシーは anon/authenticated で書く。

-- --- profiles -------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.shares_room_with(id));

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert to authenticated
  with check (id = (select auth.uid()));

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using      (id = (select auth.uid()))
  with check (id = (select auth.uid()));
-- DELETE ポリシーは作らない = 誰も profiles を消せない（auth.users 削除時のみ cascade）

-- --- rooms ----------------------------------------------------------
drop policy if exists rooms_select_member on public.rooms;
create policy rooms_select_member on public.rooms
  for select to authenticated
  using (public.is_room_member(id));
-- INSERT / UPDATE / DELETE ポリシーは作らない。
-- 作成・招待コード操作は create_room / revoke_invite / regenerate_invite RPC 経由のみ。

-- --- room_members ---------------------------------------------------
drop policy if exists room_members_select on public.room_members;
create policy room_members_select on public.room_members
  for select to authenticated
  using (public.is_room_member(room_id));   -- ← 直接参照せず関数経由（無限再帰対策）

drop policy if exists room_members_delete_self on public.room_members;
create policy room_members_delete_self on public.room_members
  for delete to authenticated
  using (user_id = (select auth.uid()));    -- 自分の退出のみ。相手は追い出せない
-- INSERT / UPDATE ポリシーは作らない（参加は join_room RPC のみ）

-- --- restrictions ---------------------------------------------------
drop policy if exists restrictions_select_room on public.restrictions;
create policy restrictions_select_room on public.restrictions
  for select to authenticated
  using (public.is_room_member(room_id));

drop policy if exists restrictions_insert_own on public.restrictions;
create policy restrictions_insert_own on public.restrictions
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_room_member(room_id));

drop policy if exists restrictions_update_own on public.restrictions;
create policy restrictions_update_own on public.restrictions
  for update to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.is_room_member(room_id));

drop policy if exists restrictions_delete_own on public.restrictions;
create policy restrictions_delete_own on public.restrictions
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- --- heartbeat ------------------------------------------------------
-- keepalive ワークフローが未ログイン（anon）で GET するだけ。書き込みは一切不可。
drop policy if exists heartbeat_select_anyone on public.heartbeat;
create policy heartbeat_select_anyone on public.heartbeat
  for select to anon, authenticated
  using (true);


-- ---------------------------------------------------------------------
-- 8. テーブル/関数の権限（RLS の手前の防御線）
-- ---------------------------------------------------------------------
-- Supabase の既定では public スキーマの新規テーブルに anon/authenticated 双方へ
-- 広めの権限が付く。ここで明示的に絞り直しておく。
revoke all on public.profiles, public.rooms, public.room_members,
              public.restrictions, public.heartbeat
  from anon, authenticated;

grant select, insert, update          on public.profiles     to authenticated;
grant select                          on public.rooms        to authenticated;
grant select, delete                  on public.room_members to authenticated;
grant select, insert, update, delete  on public.restrictions to authenticated;
grant select                          on public.heartbeat    to anon, authenticated;

-- 関数の実行権限
revoke all on function public.is_room_member(uuid)     from public, anon;
revoke all on function public.shares_room_with(uuid)   from public, anon;
revoke all on function public.generate_invite_code()   from public, anon, authenticated;
revoke all on function public.create_room(text)        from public, anon;
revoke all on function public.join_room(text)          from public, anon;
revoke all on function public.revoke_invite(uuid)      from public, anon;
revoke all on function public.regenerate_invite(uuid)  from public, anon;

grant execute on function public.is_room_member(uuid)    to authenticated;
grant execute on function public.shares_room_with(uuid)  to authenticated;
grant execute on function public.create_room(text)       to authenticated;
grant execute on function public.join_room(text)         to authenticated;
grant execute on function public.revoke_invite(uuid)     to authenticated;
grant execute on function public.regenerate_invite(uuid) to authenticated;


-- ---------------------------------------------------------------------
-- 9. Realtime パブリケーション
-- ---------------------------------------------------------------------
--
--  ★これを忘れると変更イベントが一切飛んできません★
--  ダッシュボードの Database > Replication からでも設定できますが、
--  この SQL を実行済みなら追加操作は不要です。
--
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'restrictions'
  ) then
    alter publication supabase_realtime add table public.restrictions;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;

  -- 相手が招待コードで参加した瞬間に、こちらの「相手のリスト」タブを
  -- 招待画面から相手のリスト表示へ切り替えるために必要。
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'room_members'
  ) then
    alter publication supabase_realtime add table public.room_members;
  end if;
end;
$$;

-- ★DELETE を相手に届けるために必須★
-- replica identity が既定（主キーのみ）だと、DELETE イベントの old_record に
-- 主キーしか入らない。クライアントは room_id=eq.<uuid> でフィルタしているため、
-- room_id が入っていない DELETE イベントはフィルタに引っかからず握り潰される。
-- full にすると old_record に全列が入り、削除も正しく相手に伝わる。
alter table public.restrictions replica identity full;
alter table public.profiles     replica identity full;
-- room_members は主キーが (room_id, user_id) なので、既定の replica identity でも
-- DELETE イベントに room_id が含まれる。フィルタが効くため full は不要。


-- ---------------------------------------------------------------------
-- 10. 確認用クエリ（任意・実行して結果を目視するためのもの）
-- ---------------------------------------------------------------------
-- RLS が全テーブルで有効か:
--   select relname, relrowsecurity, relforcerowsecurity
--   from pg_class
--   where relnamespace = 'public'::regnamespace and relkind = 'r'
--   order by relname;
--   → 全行 relrowsecurity = true になっていること
--
-- ポリシー一覧:
--   select tablename, policyname, cmd, roles
--   from pg_policies where schemaname = 'public' order by tablename, policyname;
--
-- Realtime に載っているテーブル:
--   select * from pg_publication_tables where pubname = 'supabase_realtime';
