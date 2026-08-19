-- =====================================================================
--  権限の診断スクリプト
--  「この操作は許可されていません」が出るときに、どこで権限が
--  足りていないかを一覧で確認するためのもの。
--  SQL Editor に丸ごと貼って Run すると、最後の表だけが表示される。
-- =====================================================================

select * from (

  -- ---- 関数の EXECUTE 権限 ----------------------------------------
  select
    1                                                   as 区分,
    '関数'                                              as 種別,
    p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as 対象,
    case when has_function_privilege('authenticated', p.oid, 'EXECUTE')
         then 'あり' else '❌ なし' end                 as ログイン後,
    case when has_function_privilege('anon', p.oid, 'EXECUTE')
         then '⚠ あり' else 'なし' end                  as 未ログイン,
    case when p.prosecdef then 'security definer' else '-' end as 備考
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace

  union all

  -- ---- テーブルの権限 ---------------------------------------------
  select
    2,
    'テーブル',
    c.relname,
    coalesce(nullif(concat_ws(',',
      case when has_table_privilege('authenticated', c.oid, 'SELECT') then 'S' end,
      case when has_table_privilege('authenticated', c.oid, 'INSERT') then 'I' end,
      case when has_table_privilege('authenticated', c.oid, 'UPDATE') then 'U' end,
      case when has_table_privilege('authenticated', c.oid, 'DELETE') then 'D' end
    ), ''), '❌ なし'),
    coalesce(nullif(concat_ws(',',
      case when has_table_privilege('anon', c.oid, 'SELECT') then 'S' end,
      case when has_table_privilege('anon', c.oid, 'INSERT') then 'I' end,
      case when has_table_privilege('anon', c.oid, 'UPDATE') then 'U' end,
      case when has_table_privilege('anon', c.oid, 'DELETE') then 'D' end
    ), ''), 'なし'),
    'RLS=' || c.relrowsecurity ||
      ' / ポリシー' || (select count(*) from pg_policy where polrelid = c.oid) || '件'
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'

  union all

  -- ---- スキーマの USAGE 権限 --------------------------------------
  select
    3,
    'スキーマ',
    n.nspname,
    case when has_schema_privilege('authenticated', n.oid, 'USAGE')
         then 'あり' else '❌ なし' end,
    case when has_schema_privilege('anon', n.oid, 'USAGE')
         then 'あり' else 'なし' end,
    '-'
  from pg_namespace n
  where n.nspname in ('public', 'auth')

) t
order by 区分, 対象;
