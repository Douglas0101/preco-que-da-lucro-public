/**
 * Model output is untrusted dependency data.  Keep the small markdown subset
 * understood by the renderer, remove control characters/raw HTML and cap the
 * size before persistence or returning it to the browser.
 */
function stripHtmlTags(value: string): string {
  let result = "";
  let insideTag = false;
  for (const character of value) {
    if (character === "<") {
      insideTag = true;
      continue;
    }
    if (character === ">" && insideTag) {
      insideTag = false;
      continue;
    }
    if (!insideTag) result += character;
  }
  return result;
}

export function sanitizeAiOutput(value: string): string {
  const clean = Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return !(
        code <= 8 ||
        code === 11 ||
        code === 12 ||
        (code >= 14 && code <= 31) ||
        code === 127
      );
    })
    .join("");
  return stripHtmlTags(clean).slice(0, 12_000).trim();
}
