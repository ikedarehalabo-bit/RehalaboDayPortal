-- =============================================================================
-- 0002 members 移行（dblink＝DB→DB直接コピー。クリップボード経由なし）
--
-- 【新DB(rehalabo-day-portal)】の SQL Editor で実行する。
-- 事前に2箇所を旧プロジェクトの Session pooler 接続情報で置換:
--   ・HOST     … 例 aws-0-ap-northeast-1.pooler.supabase.com（旧projectのConnectでコピー）
--   ・PASSWORD … 旧プロジェクトのDBパスワード
--   ・user は postgres.iaiomjjqzecbgeoqsicw（旧project ref）で固定
--
-- ※ 一度だけ実行（membersにUNIQUEなし＝再実行で重複）。実行前に members が空か確認。
-- ※ 氏名・座標は2つのDB間だけを通る。AI・クリップボードには載らない。
-- ※ 旧「町田デイ」→新「デイ町田」マッピング済み。address_raw(生住所)は移行しない。
-- =============================================================================

create extension if not exists dblink;

insert into members (tenant_id, store_id, customer_no, name, lat, lng, geocoded, care_level,
                     is_yoshien, default_weekdays, default_session, wheelchair, needs_transport, active)
select
  (select id from tenants limit 1),
  (select id from stores s where s.name = case r.store when '町田デイ' then 'デイ町田' else r.store end),
  r.customer_no, r.name, r.lat, r.lng, r.geocoded, r.care_level, r.is_yoshien,
  r.weekdays, coalesce(nullif(r.session, ''), '終日'), r.wheelchair, r.needs_transport, r.active
from dblink(
  'host=aws-1-ap-northeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.iaiomjjqzecbgeoqsicw password=PASSWORD',
  $q$
    select st.name::text, u.customer_no::text, u.name::text,
           u.lat::double precision, u.lng::double precision, u.geocoded::boolean,
           u.care_level::text, u.is_yoshien::boolean, u.weekdays::text, u.session::text,
           u.wheelchair::boolean, u.needs_transport::boolean, u.active::boolean
    from day_users u
    join portal_stores st on st.id = u.store_id
    where st.name in ('デイ和田','デイ松ノ木','デイ高井戸','デイ高円寺','町田デイ')
  $q$
) as r(store text, customer_no text, name text, lat double precision, lng double precision,
       geocoded boolean, care_level text, is_yoshien boolean, weekdays text, session text,
       wheelchair boolean, needs_transport boolean, active boolean);

-- 確認: select count(*) from members;  → 157
