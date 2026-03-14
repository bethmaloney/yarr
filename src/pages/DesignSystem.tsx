import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Play,
  Square,
  RotateCcw,
  Settings,
  FolderOpen,
  Terminal,
  GitBranch,
  Zap,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ChevronRight,
  Copy,
  ExternalLink,
  Info,
} from "lucide-react";

/* ────────────────────────────────────────────
   Design System — Reference & Showcase
   Route: /design-system
   ──────────────────────────────────────────── */

function ColorSwatch({
  name,
  cssVar,
  oklch,
  fgVar,
  fgOklch,
}: {
  name: string;
  cssVar: string;
  oklch: string;
  fgVar?: string;
  fgOklch?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div
        className="h-14 rounded-md border border-border relative overflow-hidden"
        style={{ background: `var(${cssVar})` }}
      >
        {fgVar && (
          <div
            className="absolute bottom-2 right-2 px-2 py-0.5 rounded text-xs font-medium"
            style={{
              background: `var(${cssVar})`,
              color: `var(${fgVar})`,
            }}
          >
            Aa
          </div>
        )}
      </div>
      <div>
        <div className="text-sm font-medium">{name}</div>
        <code className="text-xs text-muted-foreground block">{cssVar}</code>
        <code className="text-[10px] text-muted-foreground/60 block">
          {oklch}
        </code>
        {fgVar && fgOklch && (
          <div className="flex items-center gap-1.5 mt-1">
            <div
              className="size-3 rounded-sm border border-border"
              style={{ background: `var(${fgVar})` }}
            />
            <code className="text-[10px] text-muted-foreground/60">
              {fgVar} &middot; {fgOklch}
            </code>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight border-b border-border pb-2">
          {title}
        </h2>
        {description && (
          <p className="text-sm text-muted-foreground mt-2">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 rounded-sm bg-secondary border border-border text-xs font-mono text-muted-foreground">
      {children}
    </kbd>
  );
}

export default function DesignSystem() {
  return (
    <main className="max-w-[1000px] mx-auto p-8 pb-24 space-y-12">
      {/* ── Header ── */}
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono uppercase tracking-widest">
          <Terminal className="size-3.5" />
          Yarr Design System
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Forge</h1>
        <p className="text-muted-foreground max-w-2xl">
          An industrial, utilitarian developer-tool aesthetic inspired by VS
          Code and Docker Desktop. Dark charcoal surfaces with a warm gold
          primary accent for brand identity. Typography uses Outfit for UI text
          and JetBrains Mono for code. Interfaces should be dense and
          information-rich with tight radii, subtle elevation through border and
          background shifts, and restrained use of color&mdash;reserve bright
          accents for interactive elements and status signals, letting content
          breathe against muted surfaces.
        </p>
        <div className="flex items-center gap-2 mt-3">
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-secondary border border-border text-xs text-muted-foreground font-mono">
            <span className="size-2 rounded-full bg-foreground" />
            Dark only
          </span>
        </div>
      </header>

      {/* ── Typography ── */}
      <Section
        title="Typography"
        description="Outfit for UI text (weights 300–700), JetBrains Mono for code and labels. Both must be explicitly loaded — no system font fallbacks."
      >
        <div className="space-y-6">
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
              Sans — Outfit
            </p>
            <div className="space-y-1">
              <p className="text-3xl font-bold tracking-tight">
                The quick brown fox jumps
              </p>
              <p className="text-xl font-semibold">
                Orchestrating Claude Code sessions
              </p>
              <p className="text-base">
                Body text at base size. Readable and clean at any viewport.
              </p>
              <p className="text-sm text-muted-foreground">
                Secondary text, smaller and muted for supporting info.
              </p>
              <p className="text-xs text-muted-foreground">
                Caption text for timestamps, metadata, and labels.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
              Hierarchy reference
            </p>
            <div className="space-y-2 text-sm">
              {(
                [
                  ["Page title", "text-3xl font-bold"],
                  ["Section title", "text-xl font-semibold"],
                  ["Body", "text-base"],
                  ["Secondary", "text-sm text-muted-foreground"],
                  ["Caption", "text-xs text-muted-foreground"],
                  [
                    "Category label",
                    "text-xs font-mono uppercase tracking-widest text-muted-foreground",
                  ],
                ] as const
              ).map(([level, classes]) => (
                <div key={level} className="flex items-baseline gap-4">
                  <span className="text-muted-foreground w-28 shrink-0">
                    {level}
                  </span>
                  <code className="text-xs text-muted-foreground/60 truncate">
                    {classes}
                  </code>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
              Mono — JetBrains Mono
            </p>
            <div className="space-y-1 font-mono">
              <p className="text-sm">
                <span className="text-primary">const</span> session ={" "}
                <span className="text-success">await</span>{" "}
                claude.spawn(prompt);
              </p>
              <p className="text-xs text-muted-foreground">
                $ claude -p &quot;fix the failing test&quot; --output-format
                json
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-6 text-sm">
            <div>
              <span className="text-muted-foreground">Light</span>
              <p className="font-light text-lg">Aa 300</p>
            </div>
            <div>
              <span className="text-muted-foreground">Regular</span>
              <p className="font-normal text-lg">Aa 400</p>
            </div>
            <div>
              <span className="text-muted-foreground">Medium</span>
              <p className="font-medium text-lg">Aa 500</p>
            </div>
            <div>
              <span className="text-muted-foreground">Semibold</span>
              <p className="font-semibold text-lg">Aa 600</p>
            </div>
            <div>
              <span className="text-muted-foreground">Bold</span>
              <p className="font-bold text-lg">Aa 700</p>
            </div>
          </div>

          {/* Small text contrast note */}
          <div className="rounded-md border border-border bg-card p-4 space-y-2">
            <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
              Small text contrast
            </p>
            <div className="flex items-center gap-6 text-xs">
              <span className="text-primary">
                Gold at text-xs — check contrast
              </span>
              <span style={{ color: "oklch(0.92 0.10 85)" }}>
                Primary-light at text-xs — safer
              </span>
              <span className="text-foreground">
                Foreground at text-xs — always safe
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Gold primary (L=0.85) can dip below WCAG AA at small sizes on dark
              surfaces. Use --primary-light (L=0.92) or --foreground for text-xs
              / text-sm.
            </p>
          </div>
        </div>
      </Section>

      {/* ── Colors ── */}
      <Section
        title="Colors"
        description="All colors defined as OKLCH values in CSS custom properties. No hardcoded hex or Tailwind palette names in component code."
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-5">
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
              Surfaces
            </p>
            <ColorSwatch
              name="Background"
              cssVar="--background"
              oklch="0.22 0.02 270"
              fgVar="--foreground"
              fgOklch="0.9 0 0"
            />
            <ColorSwatch
              name="Card"
              cssVar="--card"
              oklch="0.26 0.04 250"
              fgVar="--card-foreground"
              fgOklch="0.9 0 0"
            />
            <ColorSwatch
              name="Card Inset"
              cssVar="--card-inset"
              oklch="0.20 0.03 255"
            />
            <ColorSwatch
              name="Popover"
              cssVar="--popover"
              oklch="0.26 0.04 250"
              fgVar="--popover-foreground"
              fgOklch="0.9 0 0"
            />
            <ColorSwatch
              name="Secondary"
              cssVar="--secondary"
              oklch="0.3 0 0"
            />
            <ColorSwatch name="Muted" cssVar="--muted" oklch="0.3 0 0" />
          </div>

          <div className="space-y-4">
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
              Interactive
            </p>
            <ColorSwatch
              name="Primary (gold)"
              cssVar="--primary"
              oklch="0.85 0.15 85"
              fgVar="--primary-foreground"
              fgOklch="0.22 0.02 270"
            />
            <ColorSwatch
              name="Primary Light"
              cssVar="--primary-light"
              oklch="0.92 0.10 85"
            />
            <ColorSwatch
              name="Accent"
              cssVar="--accent"
              oklch="0.27 0.04 250"
              fgVar="--accent-foreground"
              fgOklch="0.9 0 0"
            />
            <ColorSwatch name="Ring" cssVar="--ring" oklch="0.85 0.15 85" />
            <ColorSwatch name="Border" cssVar="--border" oklch="0.3 0 0" />
            <ColorSwatch
              name="Border Hover"
              cssVar="--border-hover"
              oklch="0.40 0.02 250"
            />
            <ColorSwatch name="Input" cssVar="--input" oklch="0.3 0 0" />
          </div>

          <div className="space-y-4">
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
              Status
            </p>
            <ColorSwatch
              name="Destructive"
              cssVar="--destructive"
              oklch="0.55 0.2 25"
              fgVar="--destructive-foreground"
              fgOklch="1 0 0"
            />
            <ColorSwatch
              name="Warning"
              cssVar="--warning"
              oklch="0.75 0.15 70"
              fgVar="--warning-foreground"
              fgOklch="0.2 0.05 70"
            />
            <ColorSwatch
              name="Success"
              cssVar="--success"
              oklch="0.7 0.15 165"
            />
            <ColorSwatch name="Info" cssVar="--info" oklch="0.70 0.10 250" />
            <ColorSwatch
              name="Foreground"
              cssVar="--foreground"
              oklch="0.9 0 0"
            />
            <ColorSwatch
              name="Muted FG"
              cssVar="--muted-foreground"
              oklch="0.55 0 0"
            />
          </div>
        </div>

        {/* Status color mapping */}
        <div className="mt-6 space-y-3">
          <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
            Status color mapping
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {(
              [
                ["Running", "bg-warning", "text-warning"],
                ["Complete", "bg-success", "text-success"],
                ["Failed", "bg-destructive", "text-destructive"],
                ["Idle", "bg-muted-foreground", "text-muted-foreground"],
                ["In progress", "bg-info", "text-info"],
              ] as const
            ).map(([label, dotClass, textClass]) => (
              <div
                key={label}
                className="flex items-center gap-2 px-3 py-2 rounded-md bg-card border border-border"
              >
                <span
                  className={`size-2 rounded-full shrink-0 ${dotClass} ${label === "Running" ? "motion-safe:animate-pulse" : ""}`}
                />
                <span className={`text-sm ${textClass}`}>{label}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Always use semantic tokens for status colors — never inline hex
            values or Tailwind palette names like amber-950.
          </p>
        </div>
      </Section>

      {/* ── Buttons ── */}
      <Section title="Buttons">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button>
              <Play className="size-4" />
              Start Session
            </Button>
            <Button variant="secondary">
              <Settings className="size-4" />
              Configure
            </Button>
            <Button variant="outline">
              <FolderOpen className="size-4" />
              Open Repo
            </Button>
            <Button variant="ghost">
              <GitBranch className="size-4" />
              Branch
            </Button>
            <Button variant="destructive">
              <Square className="size-4" />
              Stop
            </Button>
            <Button variant="link">View Docs</Button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xs text-muted-foreground w-full font-mono uppercase tracking-widest">
              Sizes
            </p>
            <Button size="xs">Extra Small</Button>
            <Button size="sm">Small</Button>
            <Button size="default">Default</Button>
            <Button size="lg">Large</Button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xs text-muted-foreground w-full font-mono uppercase tracking-widest">
              Icon buttons
            </p>
            <Button size="icon-xs" variant="ghost">
              <Copy />
            </Button>
            <Button size="icon-sm" variant="ghost">
              <RotateCcw />
            </Button>
            <Button size="icon" variant="outline">
              <ExternalLink />
            </Button>
            <Button size="icon-lg" variant="secondary">
              <Terminal />
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button disabled>
              <Zap className="size-4" />
              Disabled
            </Button>
          </div>
        </div>
      </Section>

      {/* ── Interactive States ── */}
      <Section
        title="Interactive States"
        description="All interactive elements must define focus, hover, active, disabled, and selected states."
      >
        <div className="space-y-6">
          {/* Button states */}
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
              Button states
            </p>
            <div className="grid grid-cols-5 gap-3 max-w-xl">
              <div className="space-y-1.5 text-center">
                <Button size="sm">Default</Button>
                <p className="text-[10px] text-muted-foreground">Rest</p>
              </div>
              <div className="space-y-1.5 text-center">
                <Button size="sm" className="bg-primary/90">
                  Hover
                </Button>
                <p className="text-[10px] text-muted-foreground">:hover</p>
              </div>
              <div className="space-y-1.5 text-center">
                <Button size="sm" className="ring-[3px] ring-ring/50">
                  Focus
                </Button>
                <p className="text-[10px] text-muted-foreground">
                  :focus-visible
                </p>
              </div>
              <div className="space-y-1.5 text-center">
                <Button size="sm" className="scale-[0.98]">
                  Active
                </Button>
                <p className="text-[10px] text-muted-foreground">:active</p>
              </div>
              <div className="space-y-1.5 text-center">
                <Button size="sm" disabled>
                  Disabled
                </Button>
                <p className="text-[10px] text-muted-foreground">:disabled</p>
              </div>
            </div>
          </div>

          {/* Focus ring spec */}
          <div className="rounded-md border border-border bg-card p-4 space-y-2">
            <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
              Focus ring specification
            </p>
            <code className="text-xs text-muted-foreground block">
              focus-visible:ring-[3px] focus-visible:ring-ring/50
              focus-visible:outline-none
            </code>
            <p className="text-xs text-muted-foreground">
              3px gold ring at 50% opacity. Applied to buttons, inputs, selects,
              and all clickable elements. Never remove focus indicators.
            </p>
          </div>

          {/* Hover patterns */}
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
              Hover patterns
            </p>
            <div className="grid grid-cols-3 gap-3 max-w-xl">
              <div className="space-y-1.5 text-center">
                <div className="h-12 rounded-md bg-primary/90 flex items-center justify-center text-xs text-primary-foreground font-medium">
                  Opacity shift
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Buttons: hover:bg-primary/90
                </p>
              </div>
              <div className="space-y-1.5 text-center">
                <div className="h-12 rounded-md bg-card border border-primary/30 flex items-center justify-center text-xs font-medium">
                  Border highlight
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Cards: hover:border-primary/30
                </p>
              </div>
              <div className="space-y-1.5 text-center">
                <div className="h-12 rounded-md bg-accent flex items-center justify-center text-xs font-medium">
                  Background reveal
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Ghost: hover:bg-accent
                </p>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Badges ── */}
      <Section title="Badges">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Failed</Badge>
          <Badge variant="warning">Max Iters</Badge>
          <Badge variant="success">Completed</Badge>
          <Badge variant="completed">Completed</Badge>
          <Badge variant="cancelled">Cancelled</Badge>
          <Badge variant="ghost">Ghost</Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          Status badge backgrounds should use semantic token muted variants
          (e.g. --destructive-muted) rather than hardcoded Tailwind colors like
          amber-950 or emerald-950.
        </p>
      </Section>

      {/* ── Cards ── */}
      <Section
        title="Cards"
        description="Two density levels: default (p-6) for forms and detail views, compact (p-4) for dashboard grids."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Terminal className="size-4 text-primary" />
                Default Card (p-6)
              </CardTitle>
              <CardDescription>
                Forms, detail views, settings panels
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2 text-sm">
                <span className="size-2 rounded-full bg-success motion-safe:animate-pulse" />
                <span className="text-success">Running</span>
                <span className="text-muted-foreground ml-auto font-mono text-xs">
                  main &middot; a1b2c3d
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Compact card */}
          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Terminal className="size-4 text-primary" />
              <span className="text-sm font-semibold">Compact Card (p-4)</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Dashboard cards, list items — dense information display with
              tighter padding and gaps.
            </p>
            <div className="flex items-center gap-2 text-sm">
              <span className="size-2 rounded-full bg-success motion-safe:animate-pulse" />
              <span className="text-success text-xs">Running</span>
              <span className="text-muted-foreground ml-auto font-mono text-xs">
                3m 12s
              </span>
            </div>
          </div>

          {/* Error card */}
          <Card className="border-destructive/30">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <XCircle className="size-4 text-destructive" />
                Session #41
              </CardTitle>
              <CardDescription>
                Failed after 1m 45s &middot; 18k tokens
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2 text-sm">
                <span className="size-2 rounded-full bg-destructive" />
                <span className="text-destructive">Error</span>
                <span className="text-muted-foreground ml-auto font-mono text-xs">
                  fix/auth-bug
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Card with inset area */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Terminal className="size-4 text-primary" />
                Card with Inset
              </CardTitle>
              <CardDescription>
                Sunken bg-card-inset for embedded content
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div
                className="rounded-md p-3 font-mono text-xs text-muted-foreground border border-border"
                style={{ backgroundColor: "oklch(0.20 0.03 255)" }}
              >
                <span className="text-success">$</span> claude -p &quot;fix the
                auth middleware&quot;
                <br />
                <span className="text-muted-foreground/60">
                  ▍ Working on fix...
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </Section>

      {/* ── Progress Bar ── */}
      <Section
        title="Progress Bar"
        description="Used in dashboard cards for plan progress. Track uses bg-card-inset, fill uses semantic status colors."
      >
        <div className="space-y-4 max-w-md">
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Complete</span>
              <span className="text-success">100%</span>
            </div>
            <div
              className="h-1.5 rounded-full overflow-hidden"
              style={{ backgroundColor: "oklch(0.20 0.03 255)" }}
            >
              <div className="h-full rounded-full bg-success w-full" />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">In progress</span>
              <span style={{ color: "oklch(0.70 0.10 250)" }}>64%</span>
            </div>
            <div
              className="h-1.5 rounded-full overflow-hidden"
              style={{ backgroundColor: "oklch(0.20 0.03 255)" }}
            >
              <div
                className="h-full rounded-full w-[64%]"
                style={{ backgroundColor: "oklch(0.70 0.10 250)" }}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Prominent (h-2)</span>
              <span className="text-warning">42%</span>
            </div>
            <div
              className="h-2 rounded-full overflow-hidden"
              style={{ backgroundColor: "oklch(0.20 0.03 255)" }}
            >
              <div className="h-full rounded-full bg-warning w-[42%]" />
            </div>
          </div>
        </div>
      </Section>

      {/* ── Transitions & Motion ── */}
      <Section
        title="Transitions & Motion"
        description="Never use transition-all — always specify which properties transition to avoid layout thrash."
      >
        <div className="space-y-4">
          <div className="overflow-x-auto">
            <table className="text-sm w-full">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground font-mono uppercase tracking-widest">
                  <th className="pb-2 pr-4">Property</th>
                  <th className="pb-2 pr-4">Duration</th>
                  <th className="pb-2 pr-4">Easing</th>
                  <th className="pb-2">Usage</th>
                </tr>
              </thead>
              <tbody className="text-muted-foreground">
                <tr className="border-b border-border/50">
                  <td className="py-2 pr-4">
                    <code className="text-xs">
                      color, background, border, opacity
                    </code>
                  </td>
                  <td className="py-2 pr-4">150ms</td>
                  <td className="py-2 pr-4">ease-out</td>
                  <td className="py-2">All interactive elements</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-2 pr-4">
                    <code className="text-xs">transform</code>
                  </td>
                  <td className="py-2 pr-4">200ms</td>
                  <td className="py-2 pr-4">ease-out</td>
                  <td className="py-2">Chevron rotations, expand/collapse</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4">
                    <code className="text-xs">max-height, height</code>
                  </td>
                  <td className="py-2 pr-4">200ms</td>
                  <td className="py-2 pr-4">ease-in-out</td>
                  <td className="py-2">Accordion, collapsible sections</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap gap-4">
            <div className="space-y-2 text-center">
              <div className="size-2 rounded-full bg-success motion-safe:animate-pulse mx-auto" />
              <p className="text-xs text-muted-foreground">
                motion-safe:animate-pulse
              </p>
            </div>
            <div className="space-y-2 text-center">
              <div className="size-4 bg-primary rounded-sm motion-safe:animate-blink mx-auto" />
              <p className="text-xs text-muted-foreground">animate-blink</p>
            </div>
          </div>

          <div className="rounded-md border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">
              <strong className="text-foreground">Reduced motion:</strong> Wrap
              decorative animations with{" "}
              <code className="text-xs">motion-safe:</code>. Functional
              transitions use{" "}
              <code className="text-xs">motion-reduce:duration-0</code> to
              become instant.
            </p>
          </div>

          <code className="text-xs text-muted-foreground block">
            Preferred: transition-colors duration-150 — not transition-all
          </code>
        </div>
      </Section>

      {/* ── Form Controls ── */}
      <Section title="Form Controls">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-2xl">
          <div className="space-y-2">
            <Label htmlFor="prompt">Prompt</Label>
            <Input id="prompt" placeholder="Describe the task..." />
          </div>

          <div className="space-y-2">
            <Label htmlFor="repo">Repository</Label>
            <Input id="repo" value="/home/user/my-project" readOnly />
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="details">Details</Label>
            <Textarea
              id="details"
              placeholder="Additional context for the session..."
              rows={3}
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox id="autorun" />
            <Label htmlFor="autorun" className="text-sm font-normal">
              Auto-restart on failure
            </Label>
          </div>
        </div>
      </Section>

      {/* ── Status Indicators ── */}
      <Section
        title="Status Indicators"
        description="Colored dots with motion-safe:animate-pulse for active states. Always pair dots with aria-label or visible text for screen readers."
      >
        <div className="space-y-3 max-w-md">
          <div className="flex items-center gap-3 px-3 py-2 rounded-md bg-card border border-border">
            <span className="size-2 rounded-full bg-success motion-safe:animate-pulse" />
            <span className="text-sm font-medium">Running</span>
            <span className="text-xs text-muted-foreground ml-auto">
              3 active sessions
            </span>
          </div>
          <div className="flex items-center gap-3 px-3 py-2 rounded-md bg-card border border-border">
            <CheckCircle2 className="size-4 text-success" />
            <span className="text-sm font-medium">Completed</span>
            <span className="text-xs text-muted-foreground ml-auto">
              2m 14s
            </span>
          </div>
          <div className="flex items-center gap-3 px-3 py-2 rounded-md bg-card border border-border">
            <XCircle className="size-4 text-destructive" />
            <span className="text-sm font-medium">Failed</span>
            <span className="text-xs text-muted-foreground ml-auto">
              Exit code 1
            </span>
          </div>
          <div className="flex items-center gap-3 px-3 py-2 rounded-md bg-card border border-warning/30">
            <AlertTriangle className="size-4 text-warning" />
            <span className="text-sm font-medium">Warning</span>
            <span className="text-xs text-muted-foreground ml-auto">
              Context 85%
            </span>
          </div>
          <div className="flex items-center gap-3 px-3 py-2 rounded-md bg-card border border-border">
            <Info
              className="size-4"
              style={{ color: "oklch(0.70 0.10 250)" }}
            />
            <span className="text-sm font-medium">In Progress</span>
            <span className="text-xs text-muted-foreground ml-auto">
              Building...
            </span>
          </div>
        </div>
      </Section>

      {/* ── Keyboard Shortcuts ── */}
      <Section
        title="Keyboard Shortcuts"
        description="Display with styled <kbd> elements: bg-card-inset, border, rounded-sm, mono font."
      >
        <div className="space-y-1.5 max-w-sm text-sm">
          {[
            ["New session", ["Ctrl", "N"]],
            ["Stop session", ["Ctrl", "C"]],
            ["Open repository", ["Ctrl", "O"]],
            ["Command palette", ["Ctrl", "K"]],
          ].map(([label, keys]) => (
            <div
              key={label as string}
              className="flex items-center justify-between px-2.5 py-1.5 rounded-md hover:bg-card/60 transition-colors duration-150"
            >
              <span>{label as string}</span>
              <span className="flex items-center gap-1">
                {(keys as string[]).map((key, i) => (
                  <span key={key} className="flex items-center gap-1">
                    {i > 0 && (
                      <span className="text-muted-foreground/40 text-xs">
                        +
                      </span>
                    )}
                    <Kbd>{key}</Kbd>
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Spacing & Layout ── */}
      <Section title="Spacing Scale">
        <div className="space-y-2">
          {(
            [
              [1, "Tight inline gaps"],
              [2, "Icon-to-label gap"],
              [3, "List item gap, badge padding"],
              [4, "Card padding (compact/dashboard)"],
              [6, "Card padding (form/detail), groups"],
              [8, "Page padding"],
              [12, "Section spacing"],
              [16, "Page margin"],
            ] as const
          ).map(([n, usage]) => (
            <div key={n} className="flex items-center gap-3">
              <code className="text-xs text-muted-foreground w-8 text-right font-mono shrink-0">
                {n}
              </code>
              <div
                className="h-3 rounded-sm bg-primary/60 shrink-0"
                style={{ width: `${n * 4}px` }}
              />
              <span className="text-xs text-muted-foreground shrink-0 w-24">
                {n * 4}px / {n * 0.25}rem
              </span>
              <span className="text-xs text-muted-foreground/50 truncate">
                {usage}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Radius ── */}
      <Section title="Border Radius">
        <div className="flex flex-wrap gap-4">
          {(
            [
              ["xs", "var(--radius-xs)"],
              ["sm", "var(--radius-sm)"],
              ["md", "var(--radius-md)"],
              ["lg", "var(--radius-lg)"],
              ["xl", "var(--radius-xl)"],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="text-center space-y-2">
              <div
                className="size-16 bg-card border border-border"
                style={{ borderRadius: value }}
              />
              <code className="text-xs text-muted-foreground">{label}</code>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Elevation ── */}
      <Section
        title="Elevation"
        description="Conveyed through border intensity and background lightness shifts, not drop shadows. Reserve box-shadow for popovers and dropdowns only."
      >
        <div className="flex flex-wrap gap-4">
          <div className="space-y-2 text-center">
            <div className="size-20 rounded-md bg-background border border-transparent" />
            <code className="text-xs text-muted-foreground block">Level 0</code>
            <span className="text-[10px] text-muted-foreground/50">
              Background
            </span>
          </div>
          <div className="space-y-2 text-center">
            <div
              className="size-20 rounded-md border border-border"
              style={{ backgroundColor: "oklch(0.20 0.03 255)" }}
            />
            <code className="text-xs text-muted-foreground block">
              Level 0.5
            </code>
            <span className="text-[10px] text-muted-foreground/50">
              Inset / sunken
            </span>
          </div>
          <div className="space-y-2 text-center">
            <div className="size-20 rounded-md bg-card border border-border" />
            <code className="text-xs text-muted-foreground block">Level 1</code>
            <span className="text-[10px] text-muted-foreground/50">
              Cards, list items
            </span>
          </div>
          <div className="space-y-2 text-center">
            <div className="size-20 rounded-md bg-popover border border-border" />
            <code className="text-xs text-muted-foreground block">Level 2</code>
            <span className="text-[10px] text-muted-foreground/50">
              Popovers, menus
            </span>
          </div>
          <div className="space-y-2 text-center">
            <div
              className="size-20 rounded-md bg-popover border border-border"
              style={{
                boxShadow:
                  "0 4px 16px oklch(0 0 0 / 0.4), 0 1px 4px oklch(0 0 0 / 0.2)",
              }}
            />
            <code className="text-xs text-muted-foreground block">Level 3</code>
            <span className="text-[10px] text-muted-foreground/50">
              Dropdowns, dialogs
            </span>
          </div>
        </div>
      </Section>

      {/* ── Icons ── */}
      <Section title="Icons (Lucide)">
        <div className="flex flex-wrap gap-4 text-muted-foreground">
          {[
            [Play, "Play"],
            [Square, "Stop"],
            [RotateCcw, "Retry"],
            [Terminal, "Terminal"],
            [GitBranch, "Branch"],
            [FolderOpen, "Folder"],
            [Settings, "Settings"],
            [Zap, "Quick"],
            [ChevronRight, "Chevron"],
            [Info, "Info"],
          ].map(([Icon, label]) => {
            const IconComp = Icon as React.ComponentType<{
              className?: string;
            }>;
            return (
              <div
                key={label as string}
                className="flex flex-col items-center gap-1"
              >
                <IconComp className="size-5" />
                <span className="text-xs">{label as string}</span>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          Default sizing: size-4 inline with text, size-5 in icon grids.
          Icon-only buttons must have aria-label.
        </p>
      </Section>

      {/* ── Patterns ── */}
      <Section title="Patterns">
        <div className="space-y-6 max-w-2xl">
          {/* Dashboard card (ActionCard) pattern */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
              Dashboard card (ActionCard)
            </p>
            <button className="w-full text-left rounded-xl bg-card border border-border p-4 space-y-3 hover:border-primary/30 transition-colors duration-150 cursor-pointer group">
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-success motion-safe:animate-pulse" />
                <span className="text-sm font-semibold truncate">
                  my-project
                </span>
                <Badge variant="success" className="shrink-0 ml-auto">
                  running
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground truncate">
                /home/user/repos/my-project
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <GitBranch className="size-3" />
                  <span className="truncate max-w-[140px]">
                    feat/long-branch-name-here
                  </span>
                </span>
                <span className="ml-auto">3m ago</span>
              </div>
              {/* Progress bar */}
              <div
                className="h-1.5 rounded-full overflow-hidden"
                style={{ backgroundColor: "oklch(0.20 0.03 255)" }}
              >
                <div className="h-full rounded-full bg-success w-[75%]" />
              </div>
            </button>
          </div>

          {/* List item pattern */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
              List item
            </p>
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-md bg-card border border-border hover:border-primary/30 transition-colors duration-150 cursor-pointer group">
              <FolderOpen className="size-4 text-muted-foreground group-hover:text-primary transition-colors duration-150" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">my-project</div>
                <div className="text-xs text-muted-foreground truncate">
                  /home/user/repos/my-project
                </div>
              </div>
              <Badge variant="success" className="shrink-0">
                3 active
              </Badge>
              <ChevronRight className="size-4 text-muted-foreground group-hover:text-foreground transition-colors duration-150" />
            </div>
          </div>

          {/* Empty state pattern */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
              Empty state
            </p>
            <div className="flex flex-col items-center justify-center py-12 rounded-md border border-dashed border-border text-center">
              <Terminal className="size-8 text-muted-foreground mb-3" />
              <p className="text-sm font-medium">No sessions yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Add a repository to get started
              </p>
              <Button size="sm" className="mt-4">
                <FolderOpen className="size-4" />
                Add Repository
              </Button>
            </div>
          </div>

          {/* Truncation & overflow */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
              Truncation & overflow
            </p>
            <div className="space-y-2 rounded-md border border-border bg-card p-4">
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-24 shrink-0">
                  Repo path
                </span>
                <span
                  className="text-sm truncate"
                  title="/home/user/very/deeply/nested/repos/my-extremely-long-project-name"
                >
                  /home/user/very/deeply/nested/repos/my-extremely-long-project-name
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-24 shrink-0">
                  Branch
                </span>
                <span className="text-sm truncate max-w-[200px]">
                  feat/very-long-branch-name-that-describes-the-feature-in-detail
                </span>
              </div>
              <div className="flex items-start gap-3">
                <span className="text-xs text-muted-foreground w-24 shrink-0 mt-0.5">
                  Prompt
                </span>
                <span className="text-sm line-clamp-2">
                  Fix the authentication middleware to properly validate JWT
                  tokens and handle expired sessions gracefully. Also update the
                  error messages to be more descriptive for debugging purposes
                  and add proper logging throughout the auth flow.
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-24 shrink-0">
                  Timestamp
                </span>
                <span className="text-sm">2m ago</span>
                <span className="text-xs text-muted-foreground">
                  (never truncate — use relative)
                </span>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Scrollbars ── */}
      <Section
        title="Scrollbars"
        description="Dark, minimal scrollbars that match the UI. 6px width, transparent track, border-colored thumb."
      >
        <div className="flex gap-4">
          <div className="w-48 h-32 rounded-md border border-border bg-card p-3 overflow-y-auto text-xs text-muted-foreground">
            {Array.from({ length: 20 }, (_, i) => (
              <div key={i} className="py-0.5">
                Log entry {i + 1}: Processing request...
              </div>
            ))}
          </div>
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>
              <strong className="text-foreground">Width:</strong> 6px
            </p>
            <p>
              <strong className="text-foreground">Track:</strong> transparent
            </p>
            <p>
              <strong className="text-foreground">Thumb:</strong> var(--border)
            </p>
            <p>
              <strong className="text-foreground">Thumb hover:</strong>{" "}
              var(--muted-foreground)
            </p>
            <p className="mt-2">
              Firefox: <code>scrollbar-width: thin</code>
            </p>
          </div>
        </div>
      </Section>

      {/* ── Accessibility ── */}
      <Section
        title="Accessibility"
        description="OKLCH lightness makes contrast easy to verify. Gold primary passes WCAG AA on all dark surfaces at text-base+."
      >
        <div className="space-y-4">
          <div className="overflow-x-auto">
            <table className="text-sm w-full">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground font-mono uppercase tracking-widest">
                  <th className="pb-2 pr-4">Surface</th>
                  <th className="pb-2 pr-4">Lightness</th>
                  <th className="pb-2 pr-4">Min text L</th>
                  <th className="pb-2">Passes</th>
                </tr>
              </thead>
              <tbody className="text-muted-foreground">
                <tr className="border-b border-border/50">
                  <td className="py-2 pr-4">Background</td>
                  <td className="py-2 pr-4 font-mono">0.22</td>
                  <td className="py-2 pr-4 font-mono">0.62+</td>
                  <td className="py-2 text-success">WCAG AA</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="py-2 pr-4">Card</td>
                  <td className="py-2 pr-4 font-mono">0.24</td>
                  <td className="py-2 pr-4 font-mono">0.65+</td>
                  <td className="py-2 text-success">WCAG AA</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4">Card inset</td>
                  <td className="py-2 pr-4 font-mono">0.20</td>
                  <td className="py-2 pr-4 font-mono">0.60+</td>
                  <td className="py-2 text-success">WCAG AA</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-md border border-border bg-card p-3 space-y-1">
              <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                Focus visibility
              </p>
              <p className="text-xs text-muted-foreground">
                3px gold ring on :focus-visible. Never suppress outline or ring.
              </p>
            </div>
            <div className="rounded-md border border-border bg-card p-3 space-y-1">
              <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                Reduced motion
              </p>
              <p className="text-xs text-muted-foreground">
                Decorative animations gated behind motion-safe:. Functional
                transitions use motion-reduce:duration-0.
              </p>
            </div>
            <div className="rounded-md border border-border bg-card p-3 space-y-1">
              <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                Screen readers
              </p>
              <p className="text-xs text-muted-foreground">
                Status dots need aria-label. Icon-only buttons need aria-label.
                Toasts use role=&quot;status&quot;.
              </p>
            </div>
          </div>
        </div>
      </Section>
    </main>
  );
}
