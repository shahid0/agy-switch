import type { Account, QuotaBucket } from "./store.ts";

const QUOTA_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.googleapis.com",
];

const UA = "antigravity/hub/2.24.0 (aidev_client)";

/** Models that share limits, as Google groups them, e.g. "Claude and GPT models". */
export type QuotaGroup = {
  name: string;
  /** The models Google lists for the group, e.g. "Claude Opus, Claude Sonnet, GPT-OSS". */
  models: string;
  buckets: QuotaBucket[];
};

type Bucket = {
  bucketId?: string;
  remainingFraction?: number;
  resetTime?: string;
  window?: string;
};

type Summary = {
  groups?: Array<{ displayName?: string; description?: string; buckets?: Bucket[] }>;
};

type Available = {
  models?: Record<string, { quotaInfo?: { remainingFraction?: number; resetTime?: string } }>;
};

const percent = (fraction: number) => Math.round(Math.max(0, Math.min(1, fraction)) * 100);

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error("Couldn't reach Google. Check your internet connection.");
  }
}

async function accessTokenFor(account: Account): Promise<string> {
  if (account.accessToken && (account.expiresAt ?? 0) > Date.now() + 60_000) {
    return account.accessToken;
  }
  const res = await request("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: account.acpToken.client_id,
      client_secret: account.acpToken.client_secret,
      refresh_token: account.acpToken.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (res.status === 400 || res.status === 401) {
    throw new Error("Google no longer accepts this account's sign-in. Sign in again with: agy-switch add");
  }
  if (!res.ok) throw new Error(`Google's sign-in service returned HTTP ${res.status}.`);
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

/**
 * Read quota straight from Google.
 *
 * `retrieveUserQuotaSummary` gives per-bucket remainingFraction; when it returns
 * nothing useful we fall back to `fetchAvailableModels`, matching what the
 * Antigravity harness does itself.
 */
export async function probeQuota(account: Account): Promise<QuotaGroup[]> {
  const accessToken = await accessTokenFor(account);
  const project = account.acpToken.project_id;

  const call = async (op: string, endpoint: string) => {
    const res = await request(`${endpoint}/v1internal:${op}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": UA,
      },
      body: JSON.stringify(project ? { project } : {}),
    });
    if (!res.ok) throw new Error(`Google's quota service returned HTTP ${res.status}.`);
    return res.json();
  };

  let lastError: unknown = null;
  for (const endpoint of QUOTA_ENDPOINTS) {
    try {
      const summary = (await call("retrieveUserQuotaSummary", endpoint)) as Summary;
      const groups: QuotaGroup[] = (summary.groups ?? [])
        .map((g) => {
          const name = g.displayName ?? "Other models";
          return {
            name,
            models: /^Models within this group:\s*(.+)$/i.exec(g.description ?? "")?.[1] ?? "",
            buckets: (g.buckets ?? [])
              .filter((b) => typeof b.remainingFraction === "number")
              .map((b) => ({
                name: b.bucketId ?? "unknown",
                percentage: percent(b.remainingFraction!),
                reset_time: b.resetTime ?? "",
                group: name,
                window: b.window || undefined,
              })),
          };
        })
        .filter((g) => g.buckets.length > 0);
      if (groups.length > 0) return groups;

      const avail = (await call("fetchAvailableModels", endpoint)) as Available;
      const fromModels: QuotaGroup[] = Object.entries(avail.models ?? {})
        .filter(([, v]) => typeof v.quotaInfo?.remainingFraction === "number")
        .map(([name, v]) => ({
          name,
          models: name,
          buckets: [
            {
              name,
              percentage: percent(v.quotaInfo!.remainingFraction!),
              reset_time: v.quotaInfo?.resetTime ?? "",
              group: name,
            },
          ],
        }));
      if (fromModels.length > 0) return fromModels;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Google returned no quota for this account.");
}

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => /[a-z]/.test(w));

/**
 * The quota groups a model name refers to, e.g. "claude" → "Claude and GPT
 * models", "Gemini 3 Pro" → "Gemini Models". Looks at the models each group
 * lists, then group names, then bucket ids, and stops at the first that
 * matches anything. Version numbers are ignored. More than one result means
 * the name is ambiguous.
 */
export function matchGroup(groups: QuotaGroup[], query: string): QuotaGroup[] {
  const wanted = words(query);
  if (wanted.length === 0) return [];
  const mentions = (text: string) => {
    const have = new Set(words(text));
    return wanted.every((w) => have.has(w));
  };
  const tiers: Array<(g: QuotaGroup) => boolean> = [
    (g) => g.models.split(",").some(mentions),
    (g) => mentions(g.name),
    (g) => g.buckets.some((b) => mentions(b.name)),
  ];
  for (const inTier of tiers) {
    const hits = groups.filter(inTier);
    if (hits.length > 0) return hits;
  }
  return [];
}
