"use client";

import { useEffect, useState } from "react";

type Store = { name: string; short_name: string | null; pool: string | null };
type RosterRow = {
  member_id: string;
  name: string;
  is_yoshien: boolean;
  needs_transport: boolean;
  planned_status: string; // expected/absent/substitute
  session: string;
  family_locked: boolean;
  saved: boolean;
};
type Other = { member_id: string; name: string };
type Stop = { user_id: string; name: string; lat: number; lng: number; eta_min: number };
type Slot = { vehicle: string; round: number; stops: Stop[]; drive_min: number; over_capacity: boolean };

const SESSIONS = ["午前", "午後", "終日"];

export default function DayRoutePage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [store, setStore] = useState("");
  const [date, setDate] = useState("");
  const [direction, setDirection] = useState<"pickup" | "dropoff">("pickup");
  const [session, setSession] = useState("午前");

  const [weekday, setWeekday] = useState("");
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [others, setOthers] = useState<Other[]>([]);
  const [addSel, setAddSel] = useState("");
  const [loadingAtt, setLoadingAtt] = useState(false);
  const [savingAtt, setSavingAtt] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [unassigned, setUnassigned] = useState<{ user_id: string; name: string; reason: string }[]>([]);
  const [routeSource, setRouteSource] = useState("");
  const [genLoading, setGenLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [rideDone, setRideDone] = useState<Set<string>>(new Set());

  useEffect(() => {
    setDate(new Date().toISOString().slice(0, 10));
    fetch("/api/day/stores")
      .then((r) => r.json())
      .then((d) => {
        setStores(d.stores ?? []);
        if (d.stores?.length) setStore(d.stores[0].name);
      })
      .catch(() => {});
  }, []);

  const loadAttendance = async () => {
    if (!store || !date) return;
    setLoadingAtt(true);
    setSlots(null);
    setSavedMsg("");
    setMsg("");
    try {
      const r = await fetch(`/api/day/attendance?store=${encodeURIComponent(store)}&date=${date}`);
      const d = await r.json();
      if (!d.ok) {
        setMsg(`出欠読込エラー: ${d.reason ?? ""}`);
        setRoster([]);
        setOthers([]);
        return;
      }
      setWeekday(d.weekday);
      setRoster(d.roster ?? []);
      setOthers(d.others ?? []);
      if (!d.roster?.length) setMsg(`${d.weekday}曜の対象者がいません（曜日データ未設定の可能性）。`);
    } finally {
      setLoadingAtt(false);
    }
  };

  // 店舗・日付が変わったら出欠を自動読込
  useEffect(() => {
    if (store && date) loadAttendance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, date]);

  const toggle = (id: string) =>
    setRoster((rs) =>
      rs.map((r) =>
        r.member_id === id
          ? { ...r, planned_status: r.planned_status === "absent" ? (r.saved ? "expected" : "expected") : "absent" }
          : r,
      ),
    );
  const setRowSession = (id: string, s: string) =>
    setRoster((rs) => rs.map((r) => (r.member_id === id ? { ...r, session: s } : r)));

  const addSubstitute = () => {
    if (!addSel) return;
    const o = others.find((x) => x.member_id === addSel);
    if (!o) return;
    setRoster((rs) => [
      ...rs,
      { member_id: o.member_id, name: o.name, is_yoshien: false, needs_transport: true, planned_status: "substitute", session, family_locked: false, saved: false },
    ]);
    setOthers((os) => os.filter((x) => x.member_id !== addSel));
    setAddSel("");
  };

  const saveAttendance = async () => {
    setSavingAtt(true);
    setSavedMsg("");
    try {
      const entries = roster.map((r) => ({ member_id: r.member_id, planned_status: r.planned_status, session: r.session }));
      const r = await fetch("/api/day/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ store, date, entries }),
      });
      const d = await r.json();
      if (d.ok) {
        setSavedMsg(`出欠を保存しました（${d.saved}件）`);
        setRoster((rs) => rs.map((r) => ({ ...r, saved: true })));
      } else setSavedMsg(`保存エラー: ${d.detail ?? d.reason ?? ""}`);
    } finally {
      setSavingAtt(false);
    }
  };

  const generate = async () => {
    setGenLoading(true);
    setMsg("");
    setSlots(null);
    try {
      const r = await fetch("/api/day/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ store, weekday, direction, session, service_date: date }),
      });
      const d = await r.json();
      if (!d.ok) {
        setMsg(`生成エラー: ${d.reason ?? ""}${d.hint ? ` — ${d.hint}` : ""}`);
        return;
      }
      setSlots(d.slots ?? []);
      setUnassigned(d.unassigned ?? []);
      setRouteSource(d.source ?? "");
      if (!d.slots?.length) setMsg(d.note ?? "対象者がいません。");
      // 乗降記録の読込（当日の記録済みを反映）
      const et = direction === "pickup" ? "picked_up" : "dropped_off";
      const rr = await fetch(`/api/day/ride-event?store=${encodeURIComponent(store)}&date=${date}`);
      const rd = await rr.json();
      const done = new Set<string>(
        ((rd.events ?? []) as { member_id: string; event_type: string }[])
          .filter((e) => e.event_type === et)
          .map((e) => e.member_id),
      );
      setRideDone(done);
    } finally {
      setGenLoading(false);
    }
  };

  const toggleRide = async (memberId: string) => {
    const et = direction === "pickup" ? "picked_up" : "dropped_off";
    const wasDone = rideDone.has(memberId);
    setRideDone((prev) => {
      const n = new Set(prev);
      if (wasDone) n.delete(memberId);
      else n.add(memberId);
      return n;
    });
    await fetch("/api/day/ride-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ store, date, member_id: memberId, event_type: et, recorded: !wasDone }),
    }).catch(() => {});
  };

  const presentCount = roster.filter((r) => r.planned_status !== "absent").length;

  return (
    <main className="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto max-w-3xl px-5 py-8">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold">送迎ルート ／ 出欠台帳</h1>
            <p className="mt-1 text-sm text-neutral-500">出欠を確認・保存してから、確定名簿でルートを生成します。</p>
          </div>
          <button
            onClick={async () => {
              await fetch("/api/auth/session", { method: "DELETE" });
              window.location.href = "/login";
            }}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-neutral-500 ring-1 ring-neutral-200 hover:text-neutral-800 dark:ring-neutral-800 dark:hover:text-neutral-200"
          >
            ログアウト
          </button>
        </div>

        {/* 店舗タブ */}
        <div className="mt-5 flex flex-wrap gap-1.5">
          {stores.map((s) => (
            <button
              key={s.name}
              onClick={() => setStore(s.name)}
              className={`rounded-full px-3 py-1 text-sm ${
                store === s.name
                  ? "bg-teal-600 text-white"
                  : "bg-white text-neutral-600 ring-1 ring-neutral-200 dark:bg-neutral-900 dark:text-neutral-300 dark:ring-neutral-800"
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>

        {/* 条件 */}
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-xs text-neutral-500">日付</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-0.5 rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-neutral-500">方向</span>
            <select value={direction} onChange={(e) => setDirection(e.target.value as "pickup" | "dropoff")} className="mt-0.5 rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
              <option value="pickup">お迎え</option>
              <option value="dropoff">お送り</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs text-neutral-500">時間帯</span>
            <select value={session} onChange={(e) => setSession(e.target.value)} className="mt-0.5 rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
              {SESSIONS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <button onClick={loadAttendance} disabled={loadingAtt || !store} className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-200 dark:text-neutral-900">
            {loadingAtt ? "読込中…" : "出欠を読み込む"}
          </button>
        </div>

        {/* 出欠台帳 */}
        {roster.length > 0 && (
          <section className="mt-6">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">出欠台帳（{weekday}曜・{presentCount}名出席予定）</h2>
              <span className="text-xs text-neutral-400">氏名はドライバー用に表示</span>
            </div>
            <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-900">
              {roster.map((r) => (
                <li key={r.member_id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <input type="checkbox" checked={r.planned_status !== "absent"} onChange={() => toggle(r.member_id)} className="h-4 w-4 accent-teal-600" />
                  <span className={`flex-1 ${r.planned_status === "absent" ? "text-neutral-400 line-through" : ""}`}>
                    {r.name}
                    {r.is_yoshien && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-700 dark:bg-amber-950 dark:text-amber-300">要支援</span>}
                    {r.planned_status === "substitute" && <span className="ml-1 rounded bg-blue-100 px-1 text-[10px] text-blue-700 dark:bg-blue-950 dark:text-blue-300">振替</span>}
                  </span>
                  <select value={r.session} onChange={(e) => setRowSession(r.member_id, e.target.value)} className="rounded border border-neutral-300 bg-white px-1 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-800">
                    {SESSIONS.map((s) => (<option key={s} value={s}>{s}</option>))}
                  </select>
                </li>
              ))}
            </ul>

            {/* 振替追加 */}
            {others.length > 0 && (
              <div className="mt-2 flex items-center gap-2">
                <select value={addSel} onChange={(e) => setAddSel(e.target.value)} className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900">
                  <option value="">＋ 振替で追加…</option>
                  {others.map((o) => (<option key={o.member_id} value={o.member_id}>{o.name}</option>))}
                </select>
                <button onClick={addSubstitute} disabled={!addSel} className="rounded-md px-2 py-1 text-sm text-teal-700 ring-1 ring-teal-300 disabled:opacity-40 dark:text-teal-300 dark:ring-teal-800">追加</button>
              </div>
            )}

            <div className="mt-3 flex items-center gap-3">
              <button onClick={saveAttendance} disabled={savingAtt} className="rounded-md bg-teal-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                {savingAtt ? "保存中…" : "出欠を保存"}
              </button>
              <button onClick={generate} disabled={genLoading} className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-200 dark:text-neutral-900">
                {genLoading ? "生成中…" : "ルート生成"}
              </button>
              {savedMsg && <span className="text-xs text-teal-600 dark:text-teal-400">{savedMsg}</span>}
            </div>
          </section>
        )}

        {msg && <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">{msg}</p>}

        {/* ルート結果 */}
        {slots && slots.length > 0 && (
          <section className="mt-6">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">生成ルート（{direction === "pickup" ? "お迎え" : "お送り"}）</h2>
              <span className="text-xs text-neutral-400">名簿ソース: {routeSource === "attendance" ? "出欠台帳（確定）" : "マスタ（未保存）"}</span>
            </div>
            <div className="space-y-3">
              {slots.map((sl, i) => (
                <div key={i} className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
                  <div className="flex items-baseline justify-between">
                    <p className="font-medium">{sl.vehicle}<span className="ml-1 text-xs text-neutral-400">{sl.round + 1}便</span></p>
                    <span className="text-xs text-neutral-400">走行 約{sl.drive_min}分 / {sl.stops.length}名{sl.over_capacity ? "・定員超" : ""}</span>
                  </div>
                  <ol className="mt-2 space-y-1">
                    {sl.stops.map((st, j) => (
                      <li key={st.user_id} className="flex items-center gap-2 text-sm">
                        <span className="w-5 text-right text-xs text-neutral-400">{j + 1}</span>
                        <span className="flex-1">{st.name}</span>
                        <span className="text-xs text-neutral-400">目安 {st.eta_min}分</span>
                        <button
                          onClick={() => toggleRide(st.user_id)}
                          className={`rounded px-1.5 py-0.5 text-xs ${
                            rideDone.has(st.user_id)
                              ? "bg-teal-600 text-white"
                              : "text-neutral-500 ring-1 ring-neutral-300 dark:ring-neutral-700"
                          }`}
                        >
                          {direction === "pickup"
                            ? rideDone.has(st.user_id)
                              ? "乗車済"
                              : "乗車"
                            : rideDone.has(st.user_id)
                              ? "送済"
                              : "お送り"}
                        </button>
                        <a href={`https://www.google.com/maps/search/?api=1&query=${st.lat},${st.lng}`} target="_blank" rel="noreferrer" className="rounded px-1.5 py-0.5 text-xs text-teal-700 ring-1 ring-teal-300 dark:text-teal-300 dark:ring-teal-800">ナビ</a>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
            {unassigned.length > 0 && (
              <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
                未割当 {unassigned.length}名（定員/NG/要支援1便で割当不可）
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
