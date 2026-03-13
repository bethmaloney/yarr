/**
 * Utilities for extracting preview metadata from plan markdown files.
 */

/**
 * Parse a plan's markdown content to extract a display name and short excerpt.
 *
 * - The first `# ` heading line becomes the `name` (without the `# ` prefix).
 * - Text after the heading, up to the first blank line or 200 chars, becomes `excerpt`.
 * - If no `# ` heading is found, `name` is empty and the first non-blank lines
 *   (up to the first blank line or 200 chars) become the excerpt.
 */
export function parsePlanPreview(content: string): {
  name: string;
  excerpt: string;
} {
  if (!content) return { name: "", excerpt: "" };

  const lines = content.split("\n");

  let name = "";
  let bodyStartIndex = 0;

  // Check if the first non-blank line is an H1 heading
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;

    // Only match `# ` at the start of a line (H1), not `##` or `#` mid-line
    if (/^# +/.test(line)) {
      name = line.replace(/^# +/, "").trim();
      bodyStartIndex = i + 1;
    } else {
      // First non-blank line is not an H1 — no name, excerpt starts from here
      bodyStartIndex = i;
    }
    break;
  }

  // Collect excerpt lines: from bodyStartIndex up to the first blank line
  const excerptLines: string[] = [];
  for (let i = bodyStartIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") break;
    excerptLines.push(line);
  }

  let excerpt = excerptLines.join("\n");
  if (excerpt.length > 200) {
    excerpt = excerpt.slice(0, 200);
  }

  return { name, excerpt };
}

/**
 * Derive a human-readable display name for a plan file.
 *
 * - If `parsedName` is provided and non-empty, return it directly.
 * - Otherwise extract the filename from `planFile`, strip `.md` extension,
 *   and strip a leading `YYYY-MM-DD-` date prefix if present.
 * - Returns an em dash if `planFile` is null.
 */
export function planDisplayName(
  planFile: string | null,
  parsedName?: string,
): string {
  if (parsedName) return parsedName;
  if (planFile === null) return "\u2014";

  // Extract filename: handle both `/` and `\` separators
  const lastSep = Math.max(
    planFile.lastIndexOf("/"),
    planFile.lastIndexOf("\\"),
  );
  let filename = lastSep >= 0 ? planFile.slice(lastSep + 1) : planFile;

  // Strip .md extension
  if (filename.endsWith(".md")) {
    filename = filename.slice(0, -3);
  }

  // Strip leading date prefix matching YYYY-MM-DD- (exactly 4-2-2 digits + trailing dash)
  filename = filename.replace(/^\d{4}-\d{2}-\d{2}-/, "");

  return filename;
}
