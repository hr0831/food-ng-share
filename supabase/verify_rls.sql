-- =====================================================================
--  RLS 検証スクリプト
--
--  使い方:
--    1. schema.sql を実行済みにする
--    2. できれば2人ともログインし、それぞれ1件以上登録してから実行する
--       （2人揃っていない項目は SKIP になります）
--    3. SQL Editor にこのファイルを丸ごと貼って Run
--    4. 出てきた表の「結果」列がすべて PASS / SKIP であることを確認する
--
--  このスクリプトはデータを壊しません。
--  「他人の行を DELETE できてしまった」場合だけ、その行を自動で復元します。
-- =====================================================================

create or replace function public.verify_rls()
returns table (項番 int, 項目 text, 結果 text, 詳細 text)
language plpgsql
as $$
declare
  r         record;
  v_a       uuid;
  v_b       uuid;
  v_room    uuid;
  v_target  uuid;
  v_backup  public.restrictions%rowtype;
  v_cnt     int;
  v_outsider constant uuid := '00000000-0000-4000-8000-0000000000ff';
begin
  ------------------------------------------------------------------
  -- 1. 全テーブルで RLS が有効か
  ------------------------------------------------------------------
  for r in
    select c.relname,
           c.relrowsecurity,
           (select count(*) from pg_policy p where p.polrelid = c.oid) as npol
    from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relkind = 'r'
    order by c.relname
  loop
    項番 := 1;
    項目 := format('RLS 有効: public.%s', r.relname);
    結果 := case when r.relrowsecurity then 'PASS' else 'FAIL' end;
    詳細 := format('rowsecurity=%s / ポリシー数=%s', r.relrowsecurity, r.npol);
    return next;
  end loop;

  ------------------------------------------------------------------
  -- 2. security definer 関数に search_path が固定されているか
  --    （固定しないと search_path 乗っ取りの余地が残る）
  ------------------------------------------------------------------
  for r in
    select p.proname,
           p.prosecdef,
           coalesce(array_to_string(p.proconfig, ','), '') as cfg
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prosecdef
    order by p.proname
  loop
    項番 := 2;
    項目 := format('search_path 固定: %s()', r.proname);
    結果 := case when r.cfg like '%search_path%' then 'PASS' else 'FAIL' end;
    詳細 := coalesce(nullif(r.cfg, ''), '(未設定)');
    return next;
  end loop;

  ------------------------------------------------------------------
  -- 3. 部外者（どのルームにも属さないユーザー）は何も見えないこと
  --
  --    set_config の第3引数は false（＝トランザクション局所ではない）にしている。
  --    SQL Editor の実行がトランザクションで包まれない場合、true だと設定が
  --    黙って無視され、RLS を迂回したまま「PASS」に見えてしまうため。
  --    最後に必ず reset role / 設定クリアで戻す。
  ------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_outsider, 'role', 'authenticated')::text, false);
  set role authenticated;

  -- なりすましが本当に効いているかの自己診断（ここが FAIL なら以降の結果は無意味）
  項番 := 3; 項目 := 'テスト用のロール切替が効いていること';
  結果 := case when current_user = 'authenticated'
                and auth.uid() = v_outsider then 'PASS' else 'FAIL' end;
  詳細 := format('current_user=%s / auth.uid()=%s', current_user, auth.uid());
  return next;

  select count(*) into v_cnt from public.restrictions;
  項番 := 3; 項目 := '部外者から restrictions が見えないこと';
  結果 := case when v_cnt = 0 then 'PASS' else 'FAIL' end;
  詳細 := format('見えた件数=%s（0件が正しい）', v_cnt);
  return next;

  select count(*) into v_cnt from public.rooms;
  項番 := 3; 項目 := '部外者から rooms が見えないこと';
  結果 := case when v_cnt = 0 then 'PASS' else 'FAIL' end;
  詳細 := format('見えた件数=%s（0件が正しい）', v_cnt);
  return next;

  reset role;
  perform set_config('request.jwt.claims', '', false);

  ------------------------------------------------------------------
  -- 4. 未ログイン（anon）から見えるのは heartbeat だけであること
  ------------------------------------------------------------------
  set role anon;

  begin
    select count(*) into v_cnt from public.heartbeat;
    項番 := 4; 項目 := 'anon から heartbeat を SELECT できること';
    結果 := 'PASS';
    詳細 := format('件数=%s', v_cnt);
  exception when others then
    項番 := 4; 項目 := 'anon から heartbeat を SELECT できること';
    結果 := 'FAIL'; 詳細 := SQLERRM;
  end;
  return next;

  begin
    insert into public.heartbeat (pinged_at) values (now());
    項番 := 4; 項目 := 'anon から heartbeat に INSERT できないこと';
    結果 := 'FAIL'; 詳細 := '書き込めてしまいました';
  exception when others then
    項番 := 4; 項目 := 'anon から heartbeat に INSERT できないこと';
    結果 := 'PASS'; 詳細 := SQLERRM;
  end;
  return next;

  begin
    select count(*) into v_cnt from public.restrictions;
    項番 := 4; 項目 := 'anon から restrictions が読めないこと';
    結果 := case when v_cnt = 0 then 'PASS' else 'FAIL' end;
    詳細 := format('見えた件数=%s（0件または権限エラーが正しい）', v_cnt);
  exception when others then
    項番 := 4; 項目 := 'anon から restrictions が読めないこと';
    結果 := 'PASS'; 詳細 := SQLERRM;
  end;
  return next;

  reset role;

  ------------------------------------------------------------------
  -- 5. Realtime パブリケーション
  --    （2人揃っていなくても確認できるので、先に済ませておく）
  ------------------------------------------------------------------
  for r in
    select unnest(array['restrictions', 'profiles', 'room_members']) as t
  loop
    項番 := 5;
    項目 := format('Realtime 配信対象: %s', r.t);
    結果 := case when exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = r.t
    ) then 'PASS' else 'FAIL' end;
    詳細 := 'supabase_realtime パブリケーション';
    return next;
  end loop;

  項番 := 5;
  項目 := 'restrictions の replica identity = full';
  結果 := case when (select relreplident from pg_class
                     where oid = 'public.restrictions'::regclass) = 'f'
               then 'PASS' else 'FAIL' end;
  詳細 := 'full でないと DELETE イベントが相手に届きません';
  return next;

  ------------------------------------------------------------------
  -- 6. 他人の行を UPDATE / DELETE できないこと
  --    （同じルームに2人いる場合のみ実施）
  ------------------------------------------------------------------
  select m1.user_id, m2.user_id, m1.room_id
    into v_a, v_b, v_room
  from public.room_members m1
  join public.room_members m2
    on m2.room_id = m1.room_id and m2.user_id <> m1.user_id
  limit 1;

  if v_a is null then
    項番 := 6; 項目 := '他人の行を書き換えられないこと';
    結果 := 'SKIP';
    詳細 := '同じルームに2人が参加してから、もう一度実行してください';
    return next;
    return;
  end if;

  select * into v_backup
  from public.restrictions
  where user_id = v_b and room_id = v_room
  limit 1;

  if v_backup.id is null then
    項番 := 6; 項目 := '他人の行を書き換えられないこと';
    結果 := 'SKIP';
    詳細 := '相手側の登録が0件です。1件登録してから、もう一度実行してください';
    return next;
    return;
  end if;
  v_target := v_backup.id;

  -- ユーザーA になりきる
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_a, 'role', 'authenticated')::text, false);
  set role authenticated;

  項番 := 6; 項目 := 'ユーザーA へのなりすましが効いていること';
  結果 := case when current_user = 'authenticated' and auth.uid() = v_a
               then 'PASS' else 'FAIL' end;
  詳細 := format('current_user=%s / auth.uid()=%s', current_user, auth.uid());
  return next;

  -- 5-1. 他人の行を UPDATE
  update public.restrictions set food = food || '_HACKED' where id = v_target;
  get diagnostics v_cnt = row_count;
  項番 := 6; 項目 := 'A が B の行を UPDATE できないこと';
  結果 := case when v_cnt = 0 then 'PASS' else 'FAIL' end;
  詳細 := format('更新された行数=%s（0件が正しい）', v_cnt);
  return next;

  -- 5-2. 他人の行を DELETE
  delete from public.restrictions where id = v_target;
  get diagnostics v_cnt = row_count;
  項番 := 6; 項目 := 'A が B の行を DELETE できないこと';
  結果 := case when v_cnt = 0 then 'PASS' else 'FAIL' end;
  詳細 := format('削除された行数=%s（0件が正しい）', v_cnt);
  return next;

  -- 5-3. 自分の行は UPDATE できること（ポリシーが厳しすぎないかの確認）
  update public.restrictions set note = note
   where user_id = v_a and room_id = v_room;
  get diagnostics v_cnt = row_count;
  項番 := 6; 項目 := 'A が自分の行を UPDATE できること';
  結果 := case when v_cnt > 0 then 'PASS' else 'SKIP' end;
  詳細 := format('更新された行数=%s（A の登録が0件なら SKIP）', v_cnt);
  return next;

  -- 5-4. 相手の行も「読める」こと（同室なので閲覧はできて当然）
  select count(*) into v_cnt
  from public.restrictions where user_id = v_b and room_id = v_room;
  項番 := 6; 項目 := 'A が B の行を SELECT できること';
  結果 := case when v_cnt > 0 then 'PASS' else 'FAIL' end;
  詳細 := format('見えた件数=%s（1件以上が正しい）', v_cnt);
  return next;

  reset role;
  perform set_config('request.jwt.claims', '', false);

  ------------------------------------------------------------------
  -- 7. 万一 DELETE / UPDATE が通ってしまっていたら元に戻す
  ------------------------------------------------------------------
  if not exists (select 1 from public.restrictions where id = v_target) then
    insert into public.restrictions
      (id, room_id, user_id, food, kind, level, note, created_at, updated_at)
    values
      (v_backup.id, v_backup.room_id, v_backup.user_id, v_backup.food,
       v_backup.kind, v_backup.level, v_backup.note,
       v_backup.created_at, v_backup.updated_at);
    項番 := 7; 項目 := '消えてしまった行の復元';
    結果 := 'INFO'; 詳細 := '削除されてしまったため復元しました（RLS を見直してください）';
    return next;
  else
    update public.restrictions
       set food = v_backup.food, updated_at = v_backup.updated_at
     where id = v_target and food <> v_backup.food;
    get diagnostics v_cnt = row_count;
    if v_cnt > 0 then
      項番 := 7; 項目 := '書き換えられた行の復元';
      結果 := 'INFO'; 詳細 := '更新されてしまったため戻しました（RLS を見直してください）';
      return next;
    end if;
  end if;

end;
$$;

-- ---------------------------------------------------------------------
-- 実行して結果を見る
--
-- ★これがこのスクリプトの最後の文であること★
-- Supabase の SQL Editor は「最後に行を返した文」の結果しか表示しないため、
-- この下に select や後片付けを足すと、検証結果の表が見えなくなる。
--
-- なりすまし用の set role / set_config は、関数が正常終了時に必ず戻している。
-- 途中でエラーになった場合も、SQL Editor の実行はトランザクションなので
-- ロールバックで自動的に元に戻る（PostgreSQL の SET はトランザクション対象）。
--
-- 検証用の関数を消したい場合は、確認が全部終わったあとに
-- 別のクエリとして次を実行する:
--     drop function if exists public.verify_rls();
-- ---------------------------------------------------------------------
select * from public.verify_rls();
