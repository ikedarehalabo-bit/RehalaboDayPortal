import { createClient } from "@supabase/supabase-js";

/**
 * ブラウザ/クライアント用の Supabase クライアント（anon key）。
 * RLS が効く前提でのみ使う。秘匿キーはここに入れない。
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(url, anonKey);
