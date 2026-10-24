// The mock and Convex each keep their own copy of names.ts (Convex can't import
// from apps/mcp). This keeps the two copies behaving identically.
import { describe, expect, it } from "vitest";
import * as mock from "../src/names.js";

// Loaded by computed URL: a static import of a file outside apps/mcp breaks
// `tsc` (TS6059, rootDir). Vitest transforms it like any other module, and
// the cast is checked at runtime by the export test below.
const CONVEX_NAMES = new URL(
  "../../../packages/backend/convex/lib/names.ts",
  import.meta.url,
).href;
const convex = (await import(CONVEX_NAMES)) as typeof mock;

const ZW = ["​", "‌", "‍", "⁠", "﻿"];

const INPUTS: string[] = [
  "",
  " ",
  "\t",
  "   　 ",
  "brief.md",
  "Brief.MD",
  "  padded name.md  ",
  "a  b  c.md",
  "tab\tand\nnewline.md",
  "line sep.md",
  "mongolian᠎vowel.md",
  "rtl‎mark.md",
  "nul\u0000byte.md",
  // NFC vs NFD, and NFKC-only equivalences.
  "café.md",
  "café.md",
  "ﬁle.md",
  "ＡＰＩ.md",
  "½-plan.md",
  "Ⅻ.md",
  // Case folding.
  "Straße.md",
  "STRASSE.md",
  "strasse.md",
  "İstanbul.md",
  "Σσς.md",
  // Zero-width characters leading, trailing, inside and alone.
  ...ZW.flatMap((z) => [z, `${z}name.md`, `name.md${z}`, `na${z}me.md`]),
  ZW.join(""),
  "\u{1F469}‍\u{1F4BB}.md",
  // Separators and dot segments.
  "/",
  "a/b",
  "/leading",
  "trailing/",
  "a／b",
  ".",
  "..",
  "...",
  " . ",
  " .. ",
  "​.",
  ".​.",
  "．．",
  ".hidden",
  // Length limits, before and after zero-width stripping.
  "x".repeat(255),
  "x".repeat(256),
  ` ${"x".repeat(255)} `,
  `${"x".repeat(255)}​`,
  `${"x".repeat(254)}é`,
  `${"x".repeat(254)}é`,
];

describe("names.ts parity: apps/mcp mock vs Convex", () => {
  it("exports the same functions and name limit", () => {
    for (const fn of [
      "storedName",
      "nameKey",
      "isValidName",
      "queryTerms",
      "matchesQuery",
    ] as const)
      expect(typeof convex[fn], fn).toBe("function");
    expect(mock.MAX_NAME_LENGTH).toBe(convex.MAX_NAME_LENGTH);
  });

  it.each(INPUTS.map((input) => [JSON.stringify(input), input]))(
    "storedName, nameKey and isValidName agree for %s",
    (_label, input) => {
      expect(mock.storedName(input)).toBe(convex.storedName(input));
      expect(mock.nameKey(input)).toBe(convex.nameKey(input));
      expect(mock.isValidName(input)).toBe(convex.isValidName(input));
      // Callers validate the stored form, so check that path too.
      const stored = convex.storedName(input);
      expect(mock.isValidName(stored)).toBe(convex.isValidName(stored));
    },
  );

  it("list_files query terms and matches agree", () => {
    const queries = [
      "",
      "   ",
      "​",
      "API",
      "api spec",
      "  spec   API  ",
      "pec",
      "Straße",
      "SS",
      "é",
      "ﬁ",
      "notes .md",
      "a/b",
      "..",
    ];
    const names = [
      "api-spec.md",
      "My API Spec.md",
      "specs",
      "STRASSE.md",
      "café.md",
      "ﬁle.md",
      "meeting notes .md",
      "a／b",
      ...INPUTS,
    ];
    for (const q of queries) {
      const terms = convex.queryTerms(q);
      expect(mock.queryTerms(q), JSON.stringify(q)).toEqual(terms);
      for (const name of names)
        expect(
          mock.matchesQuery(name, terms),
          `${JSON.stringify(q)} vs ${JSON.stringify(name)}`,
        ).toBe(convex.matchesQuery(name, terms));
    }
    expect(convex.queryTerms("  ")).toEqual([]);
    expect(
      convex.matchesQuery("My API Spec.md", convex.queryTerms("spec api")),
    ).toBe(true);
  });

  it("covers both valid and invalid names and real collisions", () => {
    const valid = INPUTS.map((i) => convex.isValidName(convex.storedName(i)));
    expect(valid).toContain(true);
    expect(valid).toContain(false);
    expect(convex.nameKey("Straße.md")).toBe(convex.nameKey("STRASSE.md"));
    expect(convex.nameKey("café.md")).toBe(convex.nameKey("café.md"));
    expect(convex.isValidName("x".repeat(256))).toBe(false);
    expect(convex.isValidName(convex.storedName("​."))).toBe(false);
  });
});
