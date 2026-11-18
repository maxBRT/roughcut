/**
 * Internal: text normalisation shared by find and the sentence model.
 */

/**
 * The searchable form of a piece of text: lower case, apostrophes removed ("it's" -> "its"),
 * every other run of punctuation or space turned into one space, trimmed. Find compares
 * these forms, which is what makes it ignore case and punctuation differences.
 */
export function normaliseForSearch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['‘’ʼ`]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Whether a word ends a sentence: its last letter-or-digit is followed by `.`, `?`, `!` or `…`. */
export function endsSentence(text: string): boolean {
  return /[.?!…]["'”’)\]]*$/u.test(text.trim());
}
