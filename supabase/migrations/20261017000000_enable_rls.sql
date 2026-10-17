-- 全テーブルの Row Level Security（RLS）を有効にし、「自分の行だけ読み書きできる」ポリシーを設定する。
-- 何度流しても同じ結果になるように作ってある（既に同名のポリシーがあれば作り直す）。
-- 本番に流す前に SECURITY_REVIEW.md の「RLSの確認手順」を読むこと。
--
-- Edge Function（import-csv）は service_role で動くため RLS を迂回する。
-- そのため import_logs への書き込みなど、アプリ画面から行わない操作のポリシーは作らない。

do $$
declare
  t text;
begin
  -- user_id 列を持ち、ログインユーザー本人だけが読み書きできるテーブル
  foreach t in array array['cards', 'card_statements', 'categories', 'subcategories', 'merchant_categories']
  loop
    if to_regclass('public.' || t) is null then
      raise notice 'テーブル % が無いためスキップします', t;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);

    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);

    execute format('create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))', t || '_select_own', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (user_id = (select auth.uid()))', t || '_insert_own', t);
    -- update は with check も付けて、user_id を他人のIDに書き換えられないようにする
    execute format('create policy %I on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t || '_update_own', t);
    execute format('create policy %I on public.%I for delete to authenticated using (user_id = (select auth.uid()))', t || '_delete_own', t);

    -- 未ログイン（anon）には一切触らせない
    execute format('revoke all on public.%I from anon', t);
  end loop;

  -- import_logs: 画面からは自分の分を読むだけ（書き込みは Edge Function = service_role のみ）
  if to_regclass('public.import_logs') is not null then
    alter table public.import_logs enable row level security;
    alter table public.import_logs force row level security;
    drop policy if exists import_logs_select_own on public.import_logs;
    create policy import_logs_select_own on public.import_logs
      for select to authenticated using (user_id = (select auth.uid()));
    revoke all on public.import_logs from anon;
    revoke insert, update, delete on public.import_logs from authenticated;
  end if;

  -- csv_import_profiles: カード会社ごとのCSV形式の設定。ログインユーザーは読むだけ
  if to_regclass('public.csv_import_profiles') is not null then
    alter table public.csv_import_profiles enable row level security;
    alter table public.csv_import_profiles force row level security;
    drop policy if exists csv_import_profiles_select_all on public.csv_import_profiles;
    create policy csv_import_profiles_select_all on public.csv_import_profiles
      for select to authenticated using (true);
    revoke all on public.csv_import_profiles from anon;
    revoke insert, update, delete on public.csv_import_profiles from authenticated;
  end if;
end $$;
