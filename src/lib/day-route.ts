/**
 * デイ送迎ルート生成（ヒューリスティック）。
 * 制約（ハード）：NG同乗禁止／要支援は1便（round0）／各車の座席・車椅子枠／回転数。
 * 目的：
 *   (1) 車両間の総走行時間をできるだけ均一化（負荷分散）。
 *   (2) 各便は必ずデポ（店舗）発・デポ着（drive_min はデポ帰着を含む）。
 * 規模（1店18名・2〜3台×2回転）なら 均衡貪欲＋最近傍＋2-opt＋移動局所探索 で十分実用。
 */
export type RouteUser = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  is_yoshien: boolean;
  wheelchair: boolean;
};
export type RouteVehicle = { id: string; name: string; seats: number; wheelchair_slots: number; rounds: number };

export type Slot = {
  vehicle: string;
  round: number; // 0=1便, 1=2便
  stops: { user_id: string; name: string; lat: number; lng: number; eta_min: number }[];
  drive_min: number; // デポ発・デポ着までの総走行時間（乗降時間含む）
  over_capacity: boolean;
};
export type RouteResult = {
  slots: Slot[];
  unassigned: { user_id: string; name: string; reason: string }[];
};

const DWELL_SEC = 180; // 1停車あたりの乗降 3分

/** matrix: (n+1)×(n+1)、index 0 = デポ（店舗）、1..n = users[i-1]。 */
export function buildRoute(
  users: RouteUser[],
  vehicles: RouteVehicle[],
  ngPairs: [string, string][],
  matrix: number[][],
): RouteResult {
  const idx = new Map(users.map((u, i) => [u.id, i + 1])); // 行列インデックス
  const ng = new Set(ngPairs.map(([a, b]) => [a, b].sort().join("|")));
  const isNg = (a: string, b: string) => ng.has([a, b].sort().join("|"));

  type Bucket = {
    vehicle: string;
    round: number;
    seats: number;
    wc: number;
    members: RouteUser[];
  };
  const buckets: Bucket[] = [];
  for (const v of vehicles) {
    for (let r = 0; r < Math.max(1, v.rounds); r++) {
      buckets.push({ vehicle: v.name, round: r, seats: v.seats, wc: v.wheelchair_slots, members: [] });
    }
  }

  const seatsLeft = (bk: Bucket) => bk.seats - bk.members.length;
  const wcLeft = (bk: Bucket) => bk.wc - bk.members.filter((m) => m.wheelchair).length;
  const feasible = (u: RouteUser, bk: Bucket) => {
    if (u.is_yoshien && bk.round !== 0) return false; // 要支援は1便
    if (seatsLeft(bk) <= 0) return false;
    if (u.wheelchair && wcLeft(bk) <= 0) return false;
    for (const m of bk.members) if (isNg(u.id, m.id)) return false; // NG同乗
    return true;
  };

  // メンバー集合の巡回順と総走行時間（秒・デポ発デポ着）。
  const routeTimeSec = (members: RouteUser[]): { order: RouteUser[]; sec: number } => {
    if (members.length === 0) return { order: [], sec: 0 };
    const order = nnThen2opt(members, matrix, idx);
    let t = 0;
    let prev = 0; // デポ
    for (const u of order) {
      const ui = idx.get(u.id)!;
      t += (matrix[prev]?.[ui] ?? 0) + DWELL_SEC;
      prev = ui;
    }
    t += matrix[prev]?.[0] ?? 0; // 最後にデポへ戻る
    return { order, sec: t };
  };

  // 車両ごとの総走行時間（秒）。バケット（便）を車両で合算。
  const vehicleTimes = (): Map<string, number> => {
    const m = new Map<string, number>();
    for (const bk of buckets) {
      const s = routeTimeSec(bk.members).sec;
      m.set(bk.vehicle, (m.get(bk.vehicle) ?? 0) + s);
    }
    return m;
  };
  const maxVehicleSec = (): number => {
    const vals = [...vehicleTimes().values()];
    return vals.length ? Math.max(...vals) : 0;
  };

  const unassigned: RouteResult["unassigned"] = [];
  // 要支援を先に（round0のみ）、次にデポから遠い順（遠い＝先に確保）
  const ordered = [...users].sort((a, b) => {
    if (a.is_yoshien !== b.is_yoshien) return a.is_yoshien ? -1 : 1;
    return (matrix[0]?.[idx.get(b.id)!] ?? 0) - (matrix[0]?.[idx.get(a.id)!] ?? 0);
  });

  // 均衡貪欲：各利用者を「入れた後の最大車両走行時間が最小になる」バケットへ。
  // 同点は挿入コスト（既存メンバー/デポへの最小移動時間）で決める。
  for (const u of ordered) {
    const cands = buckets.filter((bk) => feasible(u, bk));
    if (cands.length === 0) {
      unassigned.push({ user_id: u.id, name: u.name, reason: u.is_yoshien ? "1便の定員/NGで割当不可" : "定員/NGで割当不可" });
      continue;
    }
    let best = cands[0];
    let bestScore = Infinity;
    let bestTie = Infinity;
    const ui = idx.get(u.id)!;
    for (const bk of cands) {
      bk.members.push(u);
      const score = maxVehicleSec(); // 入れた後の最大車両走行時間
      const others = bk.members.filter((m) => m !== u);
      const tie =
        others.length === 0
          ? matrix[0]?.[ui] ?? 0
          : Math.min(...others.map((m) => matrix[idx.get(m.id)!]?.[ui] ?? 0));
      bk.members.pop();
      if (score < bestScore - 0.5 || (Math.abs(score - bestScore) <= 0.5 && tie < bestTie)) {
        best = bk;
        bestScore = score;
        bestTie = tie;
      }
    }
    best.members.push(u);
  }

  // 局所探索：最も重い車両から、別車両の実行可能バケットへ利用者を移して最大値を下げる。
  for (let iter = 0; iter < 60; iter++) {
    const vt = vehicleTimes();
    if (vt.size <= 1) break;
    const curMax = Math.max(...vt.values());
    const heaviest = [...vt.entries()].sort((a, b) => b[1] - a[1])[0][0];
    let moved = false;
    const srcBuckets = buckets.filter((bk) => bk.vehicle === heaviest);
    search: for (const src of srcBuckets) {
      for (const u of [...src.members]) {
        for (const dst of buckets) {
          if (dst.vehicle === heaviest || dst === src) continue;
          if (!feasible(u, dst)) continue;
          src.members = src.members.filter((m) => m !== u);
          dst.members.push(u);
          if (Math.max(...vehicleTimes().values()) < curMax - 1) {
            moved = true;
            break search;
          }
          dst.members.pop(); // 戻す
          src.members.push(u);
        }
      }
    }
    if (!moved) break;
  }

  // 各バケットの便を組み立て（デポ発・各点ETA・デポ着込みの drive_min）
  const slots: Slot[] = buckets
    .filter((bk) => bk.members.length > 0)
    .map((bk) => {
      const { order, sec } = routeTimeSec(bk.members);
      let t = 0;
      let prev = 0; // デポ
      const stops = order.map((u) => {
        const ui = idx.get(u.id)!;
        t += (matrix[prev]?.[ui] ?? 0) + DWELL_SEC;
        prev = ui;
        return { user_id: u.id, name: u.name, lat: u.lat, lng: u.lng, eta_min: Math.round(t / 60) };
      });
      return {
        vehicle: bk.vehicle,
        round: bk.round,
        stops,
        drive_min: Math.round(sec / 60),
        over_capacity: bk.members.length > bk.seats,
      };
    })
    .sort((a, b) => a.vehicle.localeCompare(b.vehicle) || a.round - b.round);

  return { slots, unassigned };
}

function nnThen2opt(members: RouteUser[], matrix: number[][], idx: Map<string, number>): RouteUser[] {
  if (members.length <= 1) return members;
  const d = (a: RouteUser, b: RouteUser) => matrix[idx.get(a.id)!]?.[idx.get(b.id)!] ?? 0;
  const dDepot = (a: RouteUser) => matrix[0]?.[idx.get(a.id)!] ?? 0;
  // 最近傍（デポ起点）
  const rest = [...members];
  const route: RouteUser[] = [];
  let cur: RouteUser | null = null;
  while (rest.length) {
    let bi = 0;
    let best = Infinity;
    for (let i = 0; i < rest.length; i++) {
      const c = cur ? d(cur, rest[i]) : dDepot(rest[i]);
      if (c < best) { best = c; bi = i; }
    }
    cur = rest.splice(bi, 1)[0];
    route.push(cur);
  }
  // 2-opt（デポ発着込み）
  const cost = (r: RouteUser[]) => {
    let s = dDepot(r[0]);
    for (let i = 0; i < r.length - 1; i++) s += d(r[i], r[i + 1]);
    s += dDepot(r[r.length - 1]);
    return s;
  };
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < route.length - 1; i++) {
      for (let j = i + 1; j < route.length; j++) {
        const cand = [...route.slice(0, i), ...route.slice(i, j + 1).reverse(), ...route.slice(j + 1)];
        if (cost(cand) + 1 < cost(route)) { route.splice(0, route.length, ...cand); improved = true; }
      }
    }
  }
  return route;
}
