import type { Account } from "./store.ts";

const QUOTA_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.googleapis.com",
];

const UA = "antigravity/hub/2.24.0 (aidev_client)";

type QuotaModel = { name: string; percentage: number; reset_time: string };

type QuotaResult = {
  models: QuotaModel[];
  subscription_tier?: string;
  is_forbidden?: boolean;
};

async function accessTokenFor(account: Account): Promise<string> {
  if (account.accessToken && (account.expiresAt ?? 0) > Date.now() + 60_000) {
    return account.accessToken;
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: account.acpToken.client_id,
      client_secret: account.acpToken.client_secret,
      refresh_token: account.acpToken.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed (HTTP ${res.status})`);
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

type Bucket = {
  bucketId?: string;
  displayName?: string;
  remainingFraction?: number;
  resetTime?: string;
  disabled?: boolean;
};

/**
 * Read quota straight from Google.
 *
 * `retrieveUserQuotaSummary` gives per-bucket remainingFraction; when it returns
 * nothing useful we fall back to `fetchAvailableModels`, matching what the
 * Antigravity harness does itself.
 */
export async function probeQuota(account: Account): Promise<QuotaResult> {
  const accessToken = await accessTokenFor(account);
  const project = account.acpToken.project_id;

  const call = async (op: string, endpoint: string) => {
    const res = await fetch(`${endpoint}/v1internal:${op}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": UA,
      },
      body: JSON.stringify(project ? { project } : {}),
    });
    if (!res.ok) throw new Error(`${op} HTTP ${res.status}`);
    return res.json();
  };

  let lastError: unknown = null;
  for (const endpoint of QUOTA_ENDPOINTS) {
    try {
      const summary = (await call("retrieveUserQuotaSummary", endpoint)) as {
        groups?: Array<{ buckets?: Bucket[] }>;
      };
      const buckets = (summary.groups ?? []).flatMap((g) => g.buckets ?? []);
      const models: QuotaModel[] = buckets
        .filter((b) => typeof b.remainingFraction === "number")
        .map((b) => ({
          name: b.bucketId ?? "unknown",
          percentage: Math.round(Math.max(0, Math.min(1, b.remainingFraction ?? 0)) * 100),
          reset_time: b.resetTime ?? "",
        }));
      if (models.length > 0) return { models };

      const avail = (await call("fetchAvailableModels", endpoint)) as {
        models?: Record<string, { quotaInfo?: { remainingFraction?: number; resetTime?: string } }>;
      };
      const fromModels: QuotaModel[] = Object.entries(avail.models ?? {})
        .filter(([, v]) => typeof v.quotaInfo?.remainingFraction === "number")
        .map(([name, v]) => ({
          name,
          percentage: Math.round(Math.max(0, Math.min(1, v.quotaInfo!.remainingFraction!)) * 100),
          reset_time: v.quotaInfo?.resetTime ?? "",
        }));
      if (fromModels.length > 0) return { models: fromModels };
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `Could not read quota${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
  );
}
