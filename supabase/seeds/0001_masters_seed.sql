-- =============================================================================
-- 0001 マスタ seed（PIIなし）: tenants(自社1) → pools(杉並/町田) → stores(5)
-- Supabase SQL Editor で実行。※一度だけ実行（再実行すると重複投入）。
-- デポ座標・デイ時刻は NULL（後で members/vehicles 投入時に補完）。
-- =============================================================================

with t as (
  insert into tenants (name) values ('リハラボ') returning id
),
p as (
  insert into pools (tenant_id, name)
  select t.id, v.name from t cross join (values ('杉並'),('町田')) as v(name)
  returning id, name
)
insert into stores (tenant_id, pool_id, name, short_name)
select t.id, (select id from p where p.name = s.pool), s.name, s.short
from t cross join (values
  ('デイ和田',  '和田',   '杉並'),
  ('デイ高円寺','高円寺', '杉並'),
  ('デイ松ノ木','松ノ木', '杉並'),
  ('デイ高井戸','高井戸', '杉並'),
  ('デイ町田',  '町田',   '町田')
) as s(name, short, pool);

-- 確認:
-- select s.name, s.short_name, p.name as pool
-- from stores s left join pools p on p.id = s.pool_id
-- order by pool, s.name;
