import { createClient } from "@supabase/supabase-js";

/**
 * サーバー専用の Supabase クライアント（service-role）。
 * RLS をバイパスするため、絶対にクライアントへ出さない（API ルート/サーバーのみ）。
 * 認可はアプリ層で担保する（既存ポータルの day-service.ts と同方針）。
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
