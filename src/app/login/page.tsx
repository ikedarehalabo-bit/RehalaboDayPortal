"use client";

import { useState } from "react";
import { createClient } from "@supabase/supabase-js";

// ポータル(Workプラットフォーム)のSupabase認証を使う。職員は同じアカウントでログイン。
// env 未設定でも画面が落ちないよう、クリック時に遅延生成する。
function portalClient() {
  const url = process.env.NEXT_PUBLIC_PORTAL_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_PORTAL_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return createClient(url, anon, { auth: { persistSession: false } });
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const portal = portalClient();
    if (!portal) {
      setErr("認証設定が未構成です（NEXT_PUBLIC_PORTAL_SUPABASE_* を .env.local に設定してください）。");
      setBusy(false);
      return;
    }
    const { data, error } = await portal.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      setErr("メールアドレスまたはパスワードが違います。");
      setBusy(false);
      return;
    }
    const r = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: data.session.access_token }),
    });
    if (!r.ok) {
      setErr("認証に失敗しました。もう一度お試しください。");
      setBusy(false);
      return;
    }
    const next = new URLSearchParams(window.location.search).get("next") || "/day";
    window.location.href = next;
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-5 dark:bg-neutral-950">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
        <p className="text-sm font-medium text-teal-600 dark:text-teal-400">職員ログイン</p>
        <h1 className="mt-1 text-lg font-bold text-neutral-900 dark:text-neutral-100">リハラボデイ利用者ポータル</h1>
        <p className="mt-1 text-xs text-neutral-500">ポータル（Workプラットフォーム）と同じアカウントでログインしてください。</p>

        <label className="mt-5 block text-sm text-neutral-700 dark:text-neutral-300">
          メールアドレス
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username"
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
        </label>
        <label className="mt-3 block text-sm text-neutral-700 dark:text-neutral-300">
          パスワード
          <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password"
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
        </label>

        {err && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{err}</p>}

        <button type="submit" disabled={busy}
          className="mt-5 w-full rounded-md bg-teal-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
          {busy ? "ログイン中…" : "ログイン"}
        </button>
      </form>
    </main>
  );
}
