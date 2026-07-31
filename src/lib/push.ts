import webpush from "web-push";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 乗降通知などを、member に紐づく家族/本人アカウントの購読へ Web Push 送信＋通知レコード作成。
 *
 * ※ 送信基盤（VAPID・購読検索・送信・通知記録）はここで完成。
 *   ただし家族アカウント(app_users)・紐付け(member_links)・購読(push_subscriptions)は
 *   家族ポータル（次フェーズ）で登録される。現状は受け手が0件なので送信は0件（＝基盤のみ稼働）。
 */

let configured: boolean | null = null;
function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@rehalabo.net";
  if (!pub || !priv) {
    configured = false;
    return false;
  }
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
  return true;
}

type Notify = {
  memberId: string;
  tenantId: string;
  kind: "ride" | "attendance" | "event" | "support";
  title: string;
  body: string;
  relatedId?: string;
};

/** 送信＋通知記録。返り値＝実際に push 送信できた件数。例外は握り、本体処理を止めない。 */
export async function notifyMember(db: SupabaseClient, n: Notify): Promise<number> {
  try {
    // member に閲覧権のある家族/本人アカウントを引く
    const { data: links } = await db
      .from("member_links")
      .select("app_user_id")
      .eq("member_id", n.memberId)
      .eq("can_view", true);
    const userIds = (links ?? []).map((l: { app_user_id: string }) => l.app_user_id);
    if (!userIds.length) return 0; // 受け手なし（家族ポータル未導入）

    // アプリ内通知レコードを作成
    await db.from("notifications").insert(
      userIds.map((uid) => ({
        tenant_id: n.tenantId,
        app_user_id: uid,
        kind: n.kind,
        title: n.title,
        body: n.body,
        related_id: n.relatedId ?? null,
      })),
    );

    // Web Push 送信（VAPID未設定ならスキップ）
    if (!ensureConfigured()) return 0;
    const { data: subs } = await db
      .from("push_subscriptions")
      .select("endpoint,p256dh,auth")
      .in("app_user_id", userIds);
    let sent = 0;
    for (const s of (subs ?? []) as { endpoint: string; p256dh: string; auth: string }[]) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title: n.title, body: n.body }),
        );
        sent++;
      } catch {
        /* 失効した購読は無視（掃除は別途） */
      }
    }
    return sent;
  } catch {
    return 0;
  }
}
