import { describe, expect, test } from "bun:test";
import { matchGroup, quotaGroups, type Available, type Summary } from "../src/quota.ts";

// Trimmed from what Google returned on 2026-11-13.
const summary: Summary = {
  groups: [
    {
      displayName: "Gemini Models",
      description: "Models within this group: Gemini Flash, Gemini Pro",
      buckets: [
        { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.77, resetTime: "2026-11-17T07:45:55Z" },
        { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.36, resetTime: "2026-11-13T12:30:38Z" },
      ],
    },
    {
      displayName: "Claude and GPT models",
      description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
      buckets: [
        { bucketId: "3p-weekly", window: "weekly", remainingFraction: 1, resetTime: "2026-11-16T15:59:04Z" },
        { bucketId: "3p-5h", window: "5h", remainingFraction: 1, resetTime: "2026-11-13T13:26:42Z" },
      ],
    },
    {
      displayName: "Gemini 4 Argon",
      description:
        "For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.",
      buckets: [
        { bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 0.99, resetTime: "2026-11-17T06:31:24Z" },
      ],
    },
  ],
};

// Every model reports its group's tightest limit, the image model included.
const gemini = { remainingFraction: 0.36, resetTime: "2026-11-13T12:30:38Z" };
const thirdParty = { remainingFraction: 1, resetTime: "2026-11-13T13:26:43Z" };
const available: Available = {
  models: {
    "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)", quotaInfo: gemini },
    "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)", quotaInfo: gemini },
    "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro", quotaInfo: gemini },
    "gemini-4-hydrogen-xhigh": { displayName: "Gemini 4 Hydrogen (XHigh)", quotaInfo: gemini },
    "gemini-3.1-flash-image": { displayName: "Gemini 3.1 Flash Image", quotaInfo: gemini },
    "gemini-4-argon-high": {
      displayName: "Gemini 4 Argon (High)",
      quotaInfo: { remainingFraction: 0.99, resetTime: "2026-11-17T06:31:24Z" },
    },
    "claude-opus-5-5-high": { displayName: "Claude Opus 5.5 (High)", quotaInfo: thirdParty },
    "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)", quotaInfo: thirdParty },
    "gemini-4-carbon-disabled": { displayName: "Gemini 4 Carbon", disabled: true },
    chat_20706: { isInternal: true, quotaInfo: { remainingFraction: 1 } },
    tab_flash_lite_preview: { quotaInfo: { remainingFraction: 1 } },
  },
  imageGenerationModelIds: ["gemini-3.1-flash-image"],
};

const groups = quotaGroups(summary, available);
const names = (query: string) => matchGroup(groups, query).map((g) => g.name);

describe("quotaGroups", () => {
  test("names the models in every group, Hydrogen and Argon included", () => {
    expect(groups.map((g) => [g.name, g.models])).toEqual([
      ["Gemini Models", ["Gemini 2.5 Pro", "Gemini 3.8 Flash", "Gemini 4 Hydrogen"]],
      ["Claude and GPT models", ["Claude Opus 5.5", "GPT-OSS 120B"]],
      ["Gemini 4 Argon", ["Gemini 4 Argon"]],
      ["Image generation", ["Gemini 3.1 Flash Image"]],
    ]);
  });

  test("image generation shares the Gemini Models limits and has none of its own", () => {
    expect(groups.at(-1)).toMatchObject({
      name: "Image generation",
      modelIds: ["gemini-3.1-flash-image"],
      sharesLimitsWith: "Gemini Models",
      buckets: [],
    });
  });

  test("keeps every limit with its window and reset time", () => {
    expect(groups[0].buckets).toEqual([
      { name: "gemini-weekly", percentage: 77, reset_time: "2026-11-17T07:45:55Z", group: "Gemini Models", window: "weekly" },
      { name: "gemini-5h", percentage: 36, reset_time: "2026-11-13T12:30:38Z", group: "Gemini Models", window: "5h" },
    ]);
  });

  test("without the model list, groups keep the models Google lists", () => {
    expect(quotaGroups(summary, null).map((g) => [g.name, g.models])).toEqual([
      ["Gemini Models", ["Gemini Flash", "Gemini Pro"]],
      ["Claude and GPT models", ["Claude Opus", "Claude Sonnet", "GPT-OSS"]],
      ["Gemini 4 Argon", []],
    ]);
  });

  test("with no groups in the summary, each model is its own group, and a left-out fraction is 0", () => {
    const one = { models: { "gemini-3-flash": { displayName: "Gemini 3 Flash", quotaInfo: { resetTime: "2026-11-13T12:00:00Z" } } } };
    expect(quotaGroups({ groups: [] }, one)).toEqual([
      {
        name: "gemini-3-flash",
        listed: [],
        models: ["Gemini 3 Flash"],
        modelIds: ["gemini-3-flash"],
        buckets: [{ name: "gemini-3-flash", percentage: 0, reset_time: "2026-11-13T12:00:00Z", group: "gemini-3-flash" }],
      },
    ]);
  });
});

describe("matchGroup", () => {
  test("a model or vendor name finds its group, whatever the version or case", () => {
    expect(names("claude")).toEqual(["Claude and GPT models"]);
    expect(names("Claude Sonnet 4.5")).toEqual(["Claude and GPT models"]);
    expect(names("gpt-oss")).toEqual(["Claude and GPT models"]);
    expect(names("Gemini 3 Pro")).toEqual(["Gemini Models"]);
    expect(names("flash")).toEqual(["Gemini Models"]);
  });

  test("gemini means the Gemini Models group, not Argon or image generation", () => {
    expect(names("gemini")).toEqual(["Gemini Models"]);
  });

  test("hydrogen and argon find their groups, by name or by model id", () => {
    expect(names("hydrogen")).toEqual(["Gemini Models"]);
    expect(names("gemini-4-hydrogen-xhigh")).toEqual(["Gemini Models"]);
    expect(names("argon")).toEqual(["Gemini 4 Argon"]);
    expect(names("gemini-4-argon-high")).toEqual(["Gemini 4 Argon"]);
  });

  test("image, images and the image model's id find image generation", () => {
    expect(names("image")).toEqual(["Image generation"]);
    expect(names("images")).toEqual(["Image generation"]);
    expect(names("gemini-3.1-flash-image")).toEqual(["Image generation"]);
  });

  test("falls back to bucket ids", () => {
    expect(names("3p")).toEqual(["Claude and GPT models"]);
  });

  test("a model nobody offers, or a bare number, matches nothing", () => {
    expect(names("llama")).toEqual([]);
    expect(names("4")).toEqual([]);
  });
});
