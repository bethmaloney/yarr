import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import Markdown from "react-markdown";

interface PlanPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  planContent: string;
  planFile: string;
}

function basename(filepath: string): string {
  // Handle both / and \ separators
  const parts = filepath.split(/[/\\]/);
  return parts[parts.length - 1] || filepath;
}

export function PlanPanel({
  open,
  onOpenChange,
  planContent,
  planFile,
}: PlanPanelProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="overflow-y-auto border-l border-border bg-card"
        aria-describedby={undefined}
      >
        <SheetHeader>
          <SheetTitle>{basename(planFile)}</SheetTitle>
        </SheetHeader>
        <div className="prose prose-invert max-w-none px-4 pb-4">
          <Markdown>{planContent}</Markdown>
        </div>
      </SheetContent>
    </Sheet>
  );
}
