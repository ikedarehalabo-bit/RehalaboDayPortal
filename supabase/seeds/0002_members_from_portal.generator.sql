-- =============================================================================
-- 0002 members 移行ジェネレータ（PIIを扱うため池田の手元で完結）
--
-- 手順:
--  1) このクエリを【旧ポータル(rehalabo-potal-replace)】の SQL Editor で実行
--  2) 返ってきた1セル "script"（157行のINSERT）をコピー
--  3) 【新DB(rehalabo-day-portal)】の SQL Editor に貼り付けて実行
--  4) 確認: select count(*) from members;  → 157（デイ和田120＋デイ町田37）
--
-- ※ AIは氏名・座標を受け取らない。データは旧→新のSQL Editor間だけを通る。
-- ※ 一度だけ実行（membersにUNIQUEなし＝再実行で重複）。
-- ※ 旧「町田デイ」→ 新「デイ町田」に名称マッピング済み。address_raw(生住所)は移行しない。
-- =============================================================================

select string_agg(
  format(
    'insert into members (tenant_id, store_id, customer_no, name, lat, lng, geocoded, care_level, is_yoshien, default_weekdays, default_session, wheelchair, needs_transport, active) values ((select id from tenants limit 1),(select id from stores where name=%L),%L,%L,%s,%s,%L,%L,%L,%L,%L,%L,%L);',
    case st.name when '町田デイ' then 'デイ町田' else st.name end,
    u.customer_no, u.name,
    coalesce(u.lat::text, 'null'), coalesce(u.lng::text, 'null'),
    u.geocoded, u.care_level, u.is_yoshien,
    u.weekdays, coalesce(nullif(u.session, ''), '終日'),
    u.wheelchair, u.needs_transport, u.active
  ), E'\n'
) as script
from day_users u
join portal_stores st on st.id = u.store_id
where st.name in ('デイ和田','デイ松ノ木','デイ高井戸','デイ高円寺','町田デイ');
