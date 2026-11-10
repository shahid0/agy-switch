import { describe, expect, test } from "bun:test";
import { matchGroup, type QuotaGroup } from "../src/quota.ts";

const bucket = (name: string) => ({ name, percentage: 50, reset_time: "" });

// The groups Google returns today, by name, model list and bucket id.
const groups: QuotaGroup[] = [
  { name: "Gemini Models", models: "Gemini Flash, Gemini Pro", buckets: [bucket("gemini-weekly"), bucket("gemini-5h")] },
  {
    name: "Claude and GPT models",
    models: "Claude Opus, Claude Sonnet, GPT-OSS",
    buckets: [bucket("3p-weekly"), bucket("3p-5h")],
  },
  { name: "Gemini 4 Argon", models: "", buckets: [bucket("gemini-argon-wtu-weekly")] },
];

const names = (query: string) => matchGroup(groups, query).map((g) => g.name);

describe("matchGroup", () => {
  test("a model or vendor name finds its group, whatever the version or case", () => {
    expect(names("claude")).toEqual(["Claude and GPT models"]);
    expect(names("Claude Sonnet 4.5")).toEqual(["Claude and GPT models"]);
    expect(names("gpt-oss")).toEqual(["Claude and GPT models"]);
    expect(names("Gemini 3 Pro")).toEqual(["Gemini Models"]);
  });

  test("gemini means the Gemini models group, not Argon", () => {
    expect(names("gemini")).toEqual(["Gemini Models"]);
  });

  test("falls back to group names, then bucket ids", () => {
    expect(names("argon")).toEqual(["Gemini 4 Argon"]);
    expect(names("3p")).toEqual(["Claude and GPT models"]);
  });

  test("a model nobody offers, or a bare number, matches nothing", () => {
    expect(names("llama")).toEqual([]);
    expect(names("4")).toEqual([]);
  });
});
