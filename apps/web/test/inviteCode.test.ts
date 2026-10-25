import { describe, expect, it } from "vitest";
import {
  formatInviteCode,
  generateInviteCode,
  INVITE_CODE_ALPHABET,
  isCompleteInviteCode,
  normalizeInviteCode,
} from "@/lib/inviteCode";

describe("invite codes", () => {
  it.each([
    ["abcdef", "ABCDEF"],
    ["ABC-DEF", "ABCDEF"],
    [" abc def ", "ABCDEF"],
    ["a.b_c/d\te\nf", "ABCDEF"],
    ["abc", "ABC"],
    ["", ""],
    ["123-456", ""],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeInviteCode(input)).toBe(expected);
  });

  it("treats six letters as complete", () => {
    expect(isCompleteInviteCode("ABCDEF")).toBe(true);
    expect(isCompleteInviteCode("ABCDE")).toBe(false);
    expect(isCompleteInviteCode("ABCDEFG")).toBe(false);
  });

  it("groups a full code for display only", () => {
    expect(formatInviteCode("ABCDEF")).toBe("ABC DEF");
    expect(formatInviteCode("ABC")).toBe("ABC");
  });

  it("generates six letters without I or O", () => {
    expect(INVITE_CODE_ALPHABET).not.toMatch(/[IO]/);
    for (let i = 0; i < 200; i++) expect(generateInviteCode()).toMatch(/^[A-HJ-NP-Z]{6}$/);
  });
});
