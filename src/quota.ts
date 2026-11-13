import type { Account, QuotaBucket } from "./store.ts";

// The daily endpoint first: its model list has every model agy runs use, Gemini
// 4 Hydrogen included. The other one leaves Hydrogen out.
const QUOTA_ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

const UA = "antigravity/hub/2.24.0 (aidev_client)";

/** agy-switch's group for the image generation models. Google doesn't report its own limit. */
export const IMAGE_GENERATION = "Image generation";

/** Models that share limits, as Google groups them, e.g. "Claude and GPT models". */
export type QuotaGroup = {
  name: string;
  /** The models Google lists in the group's description, e.g. ["Gemini Flash", "Gemini Pro"]. */
  listed: string[];
  /** The group's models by name, e.g. ["Gemini 3.8 Flash", "Gemini 4 Hydrogen"], or else `listed`. */
  models: string[];
  /** The ids of those models, e.g. "gemini-4-hydrogen-high", so --for takes the model a run uses. */
  modelIds: string[];
  buckets: QuotaBucket[];
  /** Another group whose limits apply too: image generation also uses Gemini Models'. */
  sharesLimitsWith?: string;
};

type Bucket = {
  bucketId?: string;
  remainingFraction?: number;
  resetTime?: string;
  window?: string;
};

export type Summary = {
  groups?: Array<{ displayName?: string; description?: string; buckets?: Bucket[] }>;
};

type Model = {
  displayName?: string;
  isInternal?: boolean;
  disabled?: boolean;
  quotaInfo?: { remainingFraction?: number; resetTime?: string };
};

export type Available = {
  models?: Record<string, Model>;
  imageGenerationModelIds?: string[];
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
 * Read quota straight from Google: the limits from `retrieveUserQuotaSummary`,
 * and which models each group covers from `fetchAvailableModels`.
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
      const [summary, available] = await Promise.all([
        call("retrieveUserQuotaSummary", endpoint) as Promise<Summary>,
        // The model list only says which models each group covers. Quota reads without it.
        (call("fetchAvailableModels", endpoint) as Promise<Available>).catch(() => null),
      ]);
      const groups = quotaGroups(summary, available);
      if (groups.length > 0) return groups;
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

/** "Gemini 4 Argon (High)" → "Gemini 4 Argon". */
const modelName = (displayName: string) => displayName.replace(/\s*\(.*\)\s*$/, "");

/** Runs each test in turn. The first that matches anything decides. */
function byTiers<T>(items: T[], tests: Array<(item: T) => boolean>): T[] {
  for (const test of tests) {
    const hits = items.filter(test);
    if (hits.length > 0) return hits;
  }
  return [];
}

/**
 * The group a model belongs to: the group named after it ("Gemini 4 Argon"),
 * else the group whose list covers it ("Gemini 3.8 Flash" is a "Gemini Flash"),
 * else the one group listing models of the same family ("Gemini 4 Hydrogen").
 */
function groupOf(groups: QuotaGroup[], model: string): QuotaGroup | undefined {
  const have = words(model);
  const hits = byTiers(groups, [
    (g) => words(g.name).every((w, i) => have[i] === w),
    (g) => g.listed.some((l) => words(l).every((w) => have.includes(w))),
    (g) => g.listed.some((l) => words(l)[0] === have[0]),
  ]);
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Google's quota groups with the models each covers, plus image generation.
 *
 * Every model in `fetchAvailableModels` reports its group's tightest limit, the
 * image model included. So image generation gets its own group here, which
 * shares the limits of the image model's group, and its own limit stays
 * unreported.
 */
export function quotaGroups(summary: Summary, available: Available | null): QuotaGroup[] {
  const groups: QuotaGroup[] = (summary.groups ?? [])
    .map((g) => {
      const name = g.displayName ?? "Other models";
      return {
        name,
        listed: (/^Models within this group:\s*(.+)$/i.exec(g.description ?? "")?.[1] ?? "")
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean),
        models: [],
        modelIds: [],
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

  const models = Object.entries(available?.models ?? {}).filter(
    ([, m]) => m.displayName && !m.isInternal && !m.disabled,
  );
  if (groups.length === 0) return perModel(models);

  const imageIds = new Set(available?.imageGenerationModelIds ?? []);
  const image: QuotaGroup = { name: IMAGE_GENERATION, listed: [], models: [], modelIds: [], buckets: [] };
  for (const [id, m] of models) {
    const name = modelName(m.displayName!);
    const home = groupOf(groups, name);
    const into = imageIds.has(id) ? image : home;
    if (into === image) image.sharesLimitsWith ??= home?.name;
    if (!into) continue;
    into.modelIds.push(id);
    if (!into.models.includes(name)) into.models.push(name);
  }

  const all = image.modelIds.length > 0 ? [...groups, image] : groups;
  for (const g of all) {
    g.models.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    if (g.models.length === 0) g.models = g.listed;
  }
  return all;
}

/** When the summary has no groups: one group per model, from the model's own quota. */
function perModel(models: Array<[string, Model]>): QuotaGroup[] {
  return models
    .filter(([, m]) => m.quotaInfo)
    .map(([id, m]) => ({
      name: id,
      listed: [],
      models: [modelName(m.displayName!)],
      modelIds: [id],
      buckets: [
        {
          name: id,
          // Google leaves out a fraction of 0, as JSON does with a protobuf default.
          percentage: percent(m.quotaInfo!.remainingFraction ?? 0),
          reset_time: m.quotaInfo!.resetTime ?? "",
          group: id,
        },
      ],
    }));
}

/**
 * The quota groups a model name refers to, e.g. "claude" → "Claude and GPT
 * models", "hydrogen" → "Gemini Models", "image" → "Image generation". Looks at
 * the models Google lists for each group, then group names, then each group's
 * models and model ids, then bucket ids, and stops at the first that matches
 * anything. Version numbers are ignored. More than one result means the name
 * is ambiguous.
 */
export function matchGroup(groups: QuotaGroup[], query: string): QuotaGroup[] {
  const wanted = words(query);
  if (wanted.length === 0) return [];
  const mentions = (text: string) => {
    const have = new Set(words(text));
    // "images" finds "Image generation".
    return wanted.every((w) => have.has(w) || (w.endsWith("s") && have.has(w.slice(0, -1))));
  };
  return byTiers(groups, [
    (g) => g.listed.some(mentions),
    (g) => mentions(g.name),
    (g) => [...g.models, ...g.modelIds].some(mentions),
    (g) => g.buckets.some((b) => mentions(b.name)),
  ]);
}
