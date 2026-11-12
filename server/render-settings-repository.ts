import { pool } from "./database";
import type { Tier } from "./tiers";

export async function readTierExportFeatures(tier: Tier) {
  const planName = tier === "pro" ? "premium" : tier;
  const result = await pool.query<{ feature_key: string; value: string | null }>(
    `SELECT f.feature_key, pf.value
     FROM plans p
     JOIN plan_features pf ON pf.plan_id = p.plan_id
     JOIN features f ON f.feature_id = pf.feature_id
     WHERE LOWER(p.name) = $1 AND f.feature_key = ANY($2::text[])`,
    [planName, ["export_resolution", "export_frame_rate"]],
  );
  return result.rows;
}

type SettingRow = { kind: "worker" | "budget"; key: string; value: string };

// One SQL statement reads both sets of settings from the same DB snapshot.
export async function readRenderSettings() {
  const result = await pool.query<SettingRow>(
    `SELECT 'worker' AS kind, LOWER(p.name) AS key, pf.value
     FROM plans p
     JOIN plan_features pf ON pf.plan_id = p.plan_id
     JOIN features f ON f.feature_id = pf.feature_id
     WHERE f.feature_key = $1 AND LOWER(p.name) = ANY($2::text[])
     UNION ALL
     SELECT 'budget' AS kind, configuration_key AS key, current_value_literal AS value
     FROM configuration WHERE configuration_key = ANY($3::text[])`,
    [
      "render_workers",
      ["free", "premium", "business"],
      ["rendering.stillsAudioBudget", "rendering.freeOverflowBudget"],
    ],
  );
  const readValue = (kind: SettingRow["kind"], key: string) => {
    const rows = result.rows.filter((row) => row.kind === kind && row.key === key);
    if (rows.length !== 1 || rows[0].value == null || rows[0].value.trim() === "") {
      throw new Error("Missing or ambiguous render configuration");
    }
    return Number(rows[0].value);
  };
  return {
    workers: {
      free: readValue("worker", "free"),
      pro: readValue("worker", "premium"),
      business: readValue("worker", "business"),
    },
    stillsAudioBudget: readValue("budget", "rendering.stillsAudioBudget"),
    freeOverflowBudget: readValue("budget", "rendering.freeOverflowBudget"),
  };
}

export const closeRenderSettingsDatabase = () => pool.end();
