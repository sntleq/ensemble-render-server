import { pool } from "./database";

export async function readUserWatermarkFeature(userId: string): Promise<string | null> {
  const result = await pool.query<{ value: string | null }>(
    `SELECT pf.value
     FROM plan_features pf
     JOIN features f ON f.feature_id = pf.feature_id
     WHERE f.feature_key = 'watermark' AND pf.plan_id = COALESCE(
       (SELECT s.plan_id FROM subscriptions s
        WHERE s.user_id = $1 AND UPPER(s.status) IN ('ACTIVE', 'TRIALING')
          AND (s.current_period_end IS NULL OR s.current_period_end > CURRENT_TIMESTAMP)
        ORDER BY s.updated_at DESC, s.created_at DESC, s.subscription_id DESC LIMIT 1),
       (SELECT p.plan_id FROM plans p WHERE LOWER(p.name) = 'free' ORDER BY p.plan_id LIMIT 1)
     )`,
    [userId],
  );
  if (result.rows.length !== 1) throw new Error("Missing or ambiguous watermark configuration");
  return result.rows[0].value;
}
