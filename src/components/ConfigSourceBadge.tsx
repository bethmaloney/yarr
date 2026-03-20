import { X } from "lucide-react";
import type { ConfigSource } from "../config";

interface ConfigSourceBadgeProps {
  source: ConfigSource;
  onReset?: () => void;
}

export function ConfigSourceBadge({ source, onReset }: ConfigSourceBadgeProps) {
  if (source === "default") {
    return null;
  }

  if (source === "yarr-yml") {
    return <span className="text-xs font-mono text-info">repo config</span>;
  }

  return (
    <>
      <span className="text-xs font-mono text-primary">custom</span>
      <button
        onClick={() => onReset?.()}
        aria-label="Reset to default"
        className="cursor-pointer text-muted-foreground hover:text-foreground transition-colors duration-150"
      >
        <X className="size-3.5" />
      </button>
    </>
  );
}
