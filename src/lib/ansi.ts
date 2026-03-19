import Anser from "anser";

export interface AnsiSegment {
  text: string;
  classes: string;
}

export function parseAnsi(raw: string): AnsiSegment[] {
  const parsed = Anser.ansiToJson(raw, { use_classes: true });
  return parsed
    .filter((entry) => entry.content.length > 0)
    .map((entry) => {
      const classes: string[] = [];
      if (entry.fg) classes.push(`ansi-fg-${entry.fg.replace(/^ansi-/, "")}`);
      if (entry.bg) classes.push(`ansi-bg-${entry.bg.replace(/^ansi-/, "")}`);
      for (const d of ((entry as { decorations?: string[] }).decorations ?? [])) {
        if (d === "bold") classes.push("ansi-bold");
        if (d === "dim") classes.push("ansi-dim");
        if (d === "italic") classes.push("ansi-italic");
        if (d === "underline") classes.push("ansi-underline");
        if (d === "strikethrough") classes.push("ansi-strikethrough");
      }
      return { text: entry.content, classes: classes.join(" ") };
    });
}
