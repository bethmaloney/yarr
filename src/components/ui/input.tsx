import * as React from "react";
import { ChevronUp, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

function NumberInput({
  className,
  min,
  max,
  step = 1,
  value,
  onChange,
  disabled,
  ...props
}: Omit<React.ComponentProps<"input">, "type" | "value" | "onChange"> & {
  value: number;
  onChange: (e: { target: { value: string } }) => void;
  step?: number;
}) {
  const numMin = min !== undefined ? Number(min) : -Infinity;
  const numMax = max !== undefined ? Number(max) : Infinity;
  const numStep = Number(step);

  const increment = () => {
    const next = Math.min(value + numStep, numMax);
    onChange({ target: { value: String(next) } });
  };

  const decrement = () => {
    const next = Math.max(value - numStep, numMin);
    onChange({ target: { value: String(next) } });
  };

  return (
    <div
      className={cn(
        "flex h-9 rounded-md border border-input shadow-xs transition-[color,box-shadow] has-[:focus-visible]:border-ring has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 dark:bg-input/30",
        disabled && "opacity-50 pointer-events-none",
        className,
      )}
    >
      <input
        type="number"
        data-slot="input"
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className="h-full w-full min-w-0 bg-transparent px-3 py-1 text-base md:text-sm outline-none border-none shadow-none focus-visible:ring-0 placeholder:text-muted-foreground disabled:cursor-not-allowed"
        {...props}
      />
      <div className="flex flex-col border-l border-input">
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          onClick={increment}
          className="flex flex-1 items-center justify-center px-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors duration-150 rounded-tr-md disabled:pointer-events-none"
          aria-label="Increment"
        >
          <ChevronUp className="size-3" />
        </button>
        <div className="h-px bg-input" />
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          onClick={decrement}
          className="flex flex-1 items-center justify-center px-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors duration-150 rounded-br-md disabled:pointer-events-none"
          aria-label="Decrement"
        >
          <ChevronDown className="size-3" />
        </button>
      </div>
    </div>
  );
}

export { Input, NumberInput };
