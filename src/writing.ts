/** Rules for text the agent writes on the user's behalf. */
export const Writing = {
  /** Removes em and en dashes, which read as AI-written. Digit ranges keep a plain hyphen. */
  clean: (text: string) =>
    text
      .replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2")
      .replace(/\s*[—–]\s*/g, ", ")
      .trim(),

  hasDashes: (text: string) => /[—–]/.test(text)
} as const;
