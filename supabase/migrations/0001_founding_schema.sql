-- =============================================================================
-- リハラボデイ利用者ポータル (RehalaboDayPortal)
-- founding migration 0001 — 独立プロダクトの創設スキーマ
-- 設計: docs/デイ利用者ポータル/台帳設計_v2_founding.md
--
-- 方針:
--  - マルチテナント: 全テーブルに tenant_id（運用は当面シングル）。
--  - SSOT: 利用者は members が唯一マスタ。
--  - PII最小化: 氏名・座標まで。病名・電話・主治医は持たない。
--  - アクセス: サーバーAPIは service-role（RLSバイパス）＋アプリ層認可。
--    RLSは全テーブルで有効化（既定deny）＝通常クライアントには素通しさせない。
--    家族の直接クライアント読取が必要になった時のため、参考ポリシーを末尾に併記（コメント）。
--
-- ⚠️ 未適用のドラフト。実行は人間ゲート（池田承認後、専用Supabaseで実行）。
-- =============================================================================

create extension if not exists pgcrypto;      -- gen_random_uuid()

-- updated_at 自動更新トリガ
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

-- =============================================================================
-- 1. マスタ層
-- =============================================================================

create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- 送迎/移動支援のドライバープール。中心座標＋半径で店舗を括る（店舗増でも自動割当可）。
create table pools (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,                    -- 例: '杉並' / '町田'
  center_lat  double precision,
  center_lng  double precision,
  radius_km   numeric(5,2) default 7.00,        -- 半径7km 既定（自動割当ルールの閾値）
  note        text,
  created_at  timestamptz not null default now()
);

create table stores (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  pool_id            uuid references pools(id) on delete set null,  -- 移動支援プール（NULL=非対象）
  name               text not null,
  short_name         text,
  kind               text not null default 'dayservice',
  lat                double precision,           -- デポ座標
  lng                double precision,
  day_start_time     time,                       -- デイ開始
  day_end_time       time,                       -- 退所
  dropoff_buffer_min int  not null default 30,   -- 夕送迎バッファ（移動支援の戻り時刻検証）
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);
create index idx_stores_tenant on stores(tenant_id);
create index idx_stores_pool   on stores(pool_id);

create table vehicles (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  store_id         uuid not null references stores(id) on delete cascade,
  name             text not null,
  seats            int  not null default 0,
  wheelchair_slots int  not null default 0,
  rounds           int  not null default 2,      -- 既定2回転
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);
create index idx_vehicles_store on vehicles(store_id);

-- 利用者マスタ = SSOT
create table members (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  store_id         uuid not null references stores(id) on delete restrict,
  customer_no      text,
  name             text not null,                -- 表示用氏名
  lat              double precision,
  lng              double precision,
  geocoded         boolean not null default false,
  care_level       text,
  is_yoshien       boolean not null default false, -- 要支援=1便制約
  default_weekdays text,                          -- 既定利用曜日（カンマ区切: '月,火,水'）
  default_session  text not null default '終日',  -- 午前/午後/終日
  wheelchair       boolean not null default false,
  needs_transport  boolean not null default true,
  note             text,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint chk_members_session check (default_session in ('午前','午後','終日'))
);
create index idx_members_tenant on members(tenant_id);
create index idx_members_store  on members(store_id);
create trigger trg_members_updated before update on members
  for each row execute function set_updated_at();

-- 認証アカウント（職員・家族・本人）。auth_user_id = Supabase Auth の user。
create table app_users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  auth_user_id  uuid not null unique,
  role          text not null,
  display_name  text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  constraint chk_app_users_role check (role in ('owner','manager','staff','driver','family','member'))
);
create index idx_app_users_tenant on app_users(tenant_id);

-- 本人/家族 ⇄ member（デイ利用者限定・招待制）
create table member_links (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  member_id    uuid not null references members(id)   on delete cascade,
  app_user_id  uuid not null references app_users(id) on delete cascade,
  relation     text not null default 'family',
  can_view     boolean not null default true,
  can_book     boolean not null default false,
  invited_by   uuid references app_users(id),
  created_at   timestamptz not null default now(),
  constraint chk_member_links_relation check (relation in ('self','family')),
  constraint uq_member_links unique (member_id, app_user_id)
);
create index idx_member_links_member on member_links(member_id);
create index idx_member_links_user   on member_links(app_user_id);

-- =============================================================================
-- 2. 出欠台帳ドメイン
-- =============================================================================

create table attendance (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  store_id       uuid not null references stores(id)  on delete cascade,
  member_id      uuid not null references members(id) on delete cascade,
  service_date   date not null,
  session        text not null default '終日',
  planned_status text not null default 'expected',   -- expected/absent/substitute
  substitute_of  date,                               -- 振替元日付
  actual_status  text,                               -- present/no_show (NULL=未確定)
  source         text not null default 'staff',      -- family/user/staff/manager/driver
  actor_role     text,
  family_locked  boolean not null default false,     -- 家族の欠席を現場が勝手に戻せない
  note           text,
  decided_by     uuid references app_users(id),
  decided_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint chk_att_session check (session in ('午前','午後','終日')),
  constraint chk_att_planned check (planned_status in ('expected','absent','substitute')),
  constraint chk_att_actual  check (actual_status is null or actual_status in ('present','no_show')),
  constraint uq_att_member_date unique (member_id, service_date)  -- 持ち越し構造的に不能
);
create index idx_att_store_date on attendance(tenant_id, store_id, service_date);
create trigger trg_att_updated before update on attendance
  for each row execute function set_updated_at();

create table attendance_log (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  attendance_id uuid not null references attendance(id) on delete cascade,
  changed_at    timestamptz not null default now(),
  changed_by    uuid references app_users(id),
  actor_role    text,
  source        text,
  field         text not null,
  old_value     text,
  new_value     text
);
create index idx_attlog_att on attendance_log(attendance_id);

create table ng_pairs (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  store_id   uuid not null references stores(id)  on delete cascade,
  member_a   uuid not null references members(id) on delete cascade,
  member_b   uuid not null references members(id) on delete cascade,
  reason     text,
  created_at timestamptz not null default now(),
  constraint chk_ng_distinct check (member_a <> member_b)
);
create index idx_ng_store on ng_pairs(store_id);

create table routes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  store_id     uuid not null references stores(id)  on delete cascade,
  service_date date not null,
  direction    text not null default 'pickup',    -- pickup/dropoff
  session      text,
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  constraint chk_routes_dir check (direction in ('pickup','dropoff'))
);
create index idx_routes_store_date on routes(store_id, service_date);

create table ride_events (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  store_id     uuid not null references stores(id)  on delete cascade,
  member_id    uuid not null references members(id) on delete cascade,
  service_date date not null,
  event_type   text not null,                     -- picked_up/dropped_off
  vehicle_id   uuid references vehicles(id) on delete set null,
  occurred_at  timestamptz not null default now(),
  by_user      uuid references app_users(id),
  notified     boolean not null default false,
  created_at   timestamptz not null default now(),
  constraint chk_ride_type check (event_type in ('picked_up','dropped_off'))
);
create index idx_ride_member_date on ride_events(member_id, service_date);

-- =============================================================================
-- 3. 移動支援ドメイン（自費・利用者限定）
-- =============================================================================

create table support_slots (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  pool_id        uuid references pools(id) on delete set null,
  base_store_id  uuid references stores(id) on delete set null,
  service_date   date not null,
  start_time     time not null,
  end_time       time not null,
  driver_capacity int not null default 1,          -- 同時に出せるドライバー数
  vehicle_id     uuid references vehicles(id) on delete set null,
  generation     text not null default 'auto',     -- auto/manual
  note           text,
  created_at     timestamptz not null default now(),
  constraint chk_slot_gen check (generation in ('auto','manual'))
);
create index idx_slots_date on support_slots(tenant_id, service_date);

create table support_reservations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  slot_id          uuid references support_slots(id) on delete set null,
  member_id        uuid not null references members(id) on delete cascade,
  service_date     date not null,
  purpose          text,                            -- 通院/買い物/その他
  destination      text,                            -- 目的地（病名等は書かない）
  pickup_time      time,
  return_time      time,
  return_over_taxi boolean not null default false,  -- 戻り超過→タクシー同乗帰宅
  fee_yen          int,                             -- 自費料金（円・記録のみ／決済なし）
  status           text not null default 'requested',
  requested_by     uuid references app_users(id),
  confirmed_by     uuid references app_users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint chk_resv_status check (status in ('requested','confirmed','done','cancelled')),
  constraint chk_resv_fee    check (fee_yen is null or fee_yen >= 0)
);
create index idx_resv_member_date on support_reservations(member_id, service_date);
create trigger trg_resv_updated before update on support_reservations
  for each row execute function set_updated_at();

-- 企画・募集型（＝概念図「広告・イベントお知らせ」）
create table events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  title       text not null,
  body        text,
  event_date  date,
  deadline    date,
  capacity    int,
  fee_yen     int,
  cover_path  text,
  status      text not null default 'open',
  created_by  uuid references app_users(id),
  created_at  timestamptz not null default now(),
  constraint chk_event_status check (status in ('open','closed','done','cancelled')),
  constraint chk_event_fee    check (fee_yen is null or fee_yen >= 0)
);
create index idx_events_tenant on events(tenant_id);

create table event_signups (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  event_id   uuid not null references events(id)  on delete cascade,
  member_id  uuid not null references members(id) on delete cascade,
  status     text not null default 'applied',
  applied_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  constraint chk_signup_status check (status in ('applied','confirmed','waitlist','cancelled')),
  constraint uq_signup unique (event_id, member_id)
);
create index idx_signup_event on event_signups(event_id);

-- =============================================================================
-- 4. 通知基盤（新規・ポータル再利用しない）
-- =============================================================================

create table push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  app_user_id  uuid not null references app_users(id) on delete cascade,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   timestamptz not null default now()
);
create index idx_push_user on push_subscriptions(app_user_id);

create table notifications (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  app_user_id  uuid not null references app_users(id) on delete cascade,
  kind         text not null,                      -- ride/attendance/event/support
  title        text not null,
  body         text,
  related_id   uuid,
  read_at      timestamptz,
  pushed_at    timestamptz,
  created_at   timestamptz not null default now(),
  constraint chk_notif_kind check (kind in ('ride','attendance','event','support'))
);
create index idx_notif_user on notifications(app_user_id, created_at desc);

-- =============================================================================
-- 5. 連絡帳ドメイン（Phase 2・枠のみ／詳細は別設計）
-- =============================================================================

create table care_notes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  store_id     uuid not null references stores(id)  on delete cascade,
  member_id    uuid not null references members(id) on delete cascade,
  service_date date not null,
  vitals       jsonb,                              -- 体温等
  meal         text,
  bath         text,
  training     text,
  note_fact    text,                               -- 「事実」
  note_action  text,                               -- 「対応」
  created_by   uuid references app_users(id),
  created_at   timestamptz not null default now()
);
create index idx_carenotes_member_date on care_notes(member_id, service_date);

create table care_note_photos (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  care_note_id uuid not null references care_notes(id) on delete cascade,
  path         text not null,
  consent_ok   boolean not null default false,     -- 掲載同意
  created_at   timestamptz not null default now()
);

-- =============================================================================
-- 6. RLS（全テーブル有効化＝既定deny。通常クライアントは素通しさせない）
--    サーバーAPIは service-role で操作（RLSバイパス）＋アプリ層認可。
-- =============================================================================

alter table tenants              enable row level security;
alter table pools                enable row level security;
alter table stores               enable row level security;
alter table vehicles             enable row level security;
alter table members              enable row level security;
alter table app_users            enable row level security;
alter table member_links         enable row level security;
alter table attendance           enable row level security;
alter table attendance_log       enable row level security;
alter table ng_pairs             enable row level security;
alter table routes               enable row level security;
alter table ride_events          enable row level security;
alter table support_slots        enable row level security;
alter table support_reservations enable row level security;
alter table events               enable row level security;
alter table event_signups        enable row level security;
alter table push_subscriptions   enable row level security;
alter table notifications        enable row level security;
alter table care_notes           enable row level security;
alter table care_note_photos     enable row level security;

-- 認可ヘルパー（家族の直接クライアント読取を将来有効化する時に使用）
create or replace function app_is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from app_users au
    where au.auth_user_id = auth.uid() and au.active
      and au.role in ('owner','manager','staff','driver')
  );
$$;

create or replace function app_can_access_member(m uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app_is_staff() or exists (
    select 1 from member_links ml
    join app_users au on au.id = ml.app_user_id
    where au.auth_user_id = auth.uid() and au.active
      and ml.member_id = m and ml.can_view
  );
$$;

-- 参考：家族が直接Supabaseから読む運用にする場合のSELECTポリシー例（現状はコメント）。
-- create policy sel_members_family   on members   for select using (app_can_access_member(id));
-- create policy sel_attendance_family on attendance for select using (app_can_access_member(member_id));
-- create policy sel_ride_family      on ride_events for select using (app_can_access_member(member_id));
-- create policy sel_resv_family      on support_reservations for select using (app_can_access_member(member_id));
-- create policy sel_notif_self       on notifications for select
--   using (exists (select 1 from app_users au where au.id = notifications.app_user_id and au.auth_user_id = auth.uid()));

-- =============================================================================
-- 7. 初期投入（データ・別途手動 or seed）
--   1) tenants に自社1行
--   2) pools: '杉並'（center=杉並中心/半径7km）／'町田'
--   3) stores: 5〜6行を複製し pool_id を設定（デイ和田/高円寺/松ノ木/高井戸→杉並、デイ町田→町田）
--   4) vehicles / members: 既存 day_* からエクスポート→インポート（PIIは画面/CSV・gitに載せない）
--   ※半径7km自動割当は、pools.center と stores.lat/lng の距離で pool_id を更新するルーチンで実施可。
-- =============================================================================
