import { describe, expect, it } from "vitest";
import { Compaction, type ChatMessage } from "./compaction";

const msg = (role: ChatMessage["role"], chars: number): ChatMessage => ({ role, content: "x".repeat(chars) });
const limits = { budgetTokens: 100, keepRecent: 2 };

describe("Compaction.plan", () => {
  it("does nothing while under budget", () => {
    expect(Compaction.plan(null, [msg("user", 40), msg("assistant", 40)], limits)).toEqual({ action: "none" });
  });

  it("does nothing when everything is within the recent window, even over budget", () => {
    expect(Compaction.plan(null, [msg("user", 800), msg("assistant", 800)], limits)).toEqual({ action: "none" });
  });

  it("keeps the newest turns verbatim and compacts the rest when over budget", () => {
    const messages = [msg("user", 200), msg("assistant", 200), msg("user", 200), msg("assistant", 20)];
    const result = Compaction.plan(null, messages, limits);
    expect(result).toEqual({ action: "compact", older: messages.slice(0, 2), recent: messages.slice(2) });
  });

  it("counts the existing summary toward the budget", () => {
    const messages = [msg("user", 40), msg("assistant", 40), msg("user", 40)];
    expect(Compaction.plan("s".repeat(400), messages, limits).action).toBe("compact");
  });
});
