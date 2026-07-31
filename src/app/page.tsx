import Link from "next/link";
import { createServiceClient } from "@/lib/supabase-server";

// 常に最新のDB状態を表示（キャッシュしない）
export const dynamic = "force-dynamic";

type StoreRow = {
  name: string;
  short_name: string | null;
  pools: { name: string } | null;
};

export default async function Home() {
  let stores: StoreRow[] = [];
  let errorMsg: string | null = null;

  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("stores")
      .select("name, short_name, pools(name)")
      .order("name");
    if (error) errorMsg = error.message;
    else stores = (data as unknown as StoreRow[]) ?? [];
  } catch (e) {
    errorMsg = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <p className="text-sm font-medium text-teal-600 dark:text-teal-400">
          セットアップ確認
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">
          リハラボデイ利用者ポータル
        </h1>
        <p className="mt-2 text-sm text-neutral-500">
          Next.js → Supabase → stores マスタ（seed投入分）を表示しています。
        </p>

        <Link
          href="/day"
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-teal-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-teal-700"
        >
          送迎ルート・出欠台帳を開く →
        </Link>

        {errorMsg ? (
          <div className="mt-8 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            <p className="font-semibold">DB接続エラー</p>
            <p className="mt-1 font-mono text-xs">{errorMsg}</p>
            <p className="mt-2">.env.local のキー3つ（URL / anon / service_role）を確認してください。</p>
          </div>
        ) : (
          <section className="mt-8">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-neutral-600 dark:text-neutral-300">
                店舗マスタ
              </h2>
              <span className="text-xs text-neutral-400">{stores.length} 店舗</span>
            </div>
            <ul className="divide-y divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 bg-white dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-900">
              {stores.map((s) => (
                <li key={s.name} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="font-medium">{s.name}</p>
                    <p className="text-xs text-neutral-400">{s.short_name ?? "—"}</p>
                  </div>
                  <span className="rounded-full bg-teal-50 px-2.5 py-1 text-xs font-medium text-teal-700 dark:bg-teal-950 dark:text-teal-300">
                    {s.pools?.name ?? "未割当"} プール
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-xs text-neutral-400">
              次: vehicles / members 投入 → 送迎エンジン移植 → 出欠台帳・移動支援・家族ポータル
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
