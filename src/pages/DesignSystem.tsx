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
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold tracking-tight border-b border-border pb-2">
        {title}
      </h2>
      {children}
    </section>
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
      <Section title="Typography">
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
              Mono — JetBrains Mono
            </p>
            <div className="space-y-1 font-mono">
              <p className="text-sm">
                <span className="text-primary">const</span> session ={" "}
                <span className="text-success">await</span>{" "}
                claude.spawn(prompt);
              </p>
              <p className="text-xs text-muted-foreground">
                $ claude -p "fix the failing test" --output-format json
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
        </div>
      </Section>

      {/* ── Colors ── */}
      <Section title="Colors">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-5">
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
              Surfaces
            </p>
            <ColorSwatch
              name="Background"
              cssVar="--background"
              oklch="0.145 0.012 260"
              fgVar="--foreground"
              fgOklch="0.93 0.005 260"
            />
            <ColorSwatch
              name="Card"
              cssVar="--card"
              oklch="0.175 0.012 260"
              fgVar="--card-foreground"
              fgOklch="0.93 0.005 260"
            />
            <ColorSwatch
              name="Popover"
              cssVar="--popover"
              oklch="0.19 0.015 255"
              fgVar="--popover-foreground"
              fgOklch="0.93 0.005 260"
            />
            <ColorSwatch
              name="Secondary"
              cssVar="--secondary"
              oklch="0.22 0.01 260"
            />
            <ColorSwatch name="Muted" cssVar="--muted" oklch="0.22 0.01 260" />
          </div>

          <div className="space-y-4">
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
              Interactive
            </p>
            <ColorSwatch
              name="Primary"
              cssVar="--primary"
              oklch="0.8 0.155 78"
              fgVar="--primary-foreground"
              fgOklch="0.16 0.02 78"
            />
            <ColorSwatch
              name="Accent"
              cssVar="--accent"
              oklch="0.22 0.02 255"
              fgVar="--accent-foreground"
              fgOklch="0.93 0.005 260"
            />
            <ColorSwatch name="Ring" cssVar="--ring" oklch="0.8 0.155 78" />
            <ColorSwatch
              name="Border"
              cssVar="--border"
              oklch="0.26 0.01 260"
            />
            <ColorSwatch name="Input" cssVar="--input" oklch="0.26 0.01 260" />
          </div>

          <div className="space-y-4">
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
              Status
            </p>
            <ColorSwatch
              name="Destructive"
              cssVar="--destructive"
              oklch="0.58 0.22 25"
              fgVar="--destructive-foreground"
              fgOklch="0.98 0 0"
            />
            <ColorSwatch
              name="Warning"
              cssVar="--warning"
              oklch="0.78 0.14 70"
              fgVar="--warning-foreground"
              fgOklch="0.2 0.03 70"
            />
            <ColorSwatch
              name="Success"
              cssVar="--success"
              oklch="0.72 0.17 160"
              fgVar="--success-foreground"
              fgOklch="0.18 0.03 160"
            />
            <ColorSwatch
              name="Muted FG"
              cssVar="--muted-foreground"
              oklch="0.55 0.01 260"
            />
          </div>
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

          <div className="space-y-3">
            <p className="text-xs text-muted-foreground w-full font-mono uppercase tracking-widest">
              Interactive states
            </p>
            <div className="grid grid-cols-4 gap-3 max-w-lg">
              <div className="space-y-1.5 text-center">
                <Button size="sm">Default</Button>
                <p className="text-[10px] text-muted-foreground">Rest</p>
              </div>
              <div className="space-y-1.5 text-center">
                <Button size="sm" className="brightness-110 scale-[1.02]">
                  Hover
                </Button>
                <p className="text-[10px] text-muted-foreground">:hover</p>
              </div>
              <div className="space-y-1.5 text-center">
                <Button
                  size="sm"
                  className="ring-2 ring-ring ring-offset-2 ring-offset-background"
                >
                  Focus
                </Button>
                <p className="text-[10px] text-muted-foreground">
                  :focus-visible
                </p>
              </div>
              <div className="space-y-1.5 text-center">
                <Button size="sm" className="brightness-90 scale-[0.98]">
                  Active
                </Button>
                <p className="text-[10px] text-muted-foreground">:active</p>
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
      </Section>

      {/* ── Cards ── */}
      <Section title="Cards">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Terminal className="size-4 text-primary" />
                Session #42
              </CardTitle>
              <CardDescription>
                Running for 3m 12s &middot; 24k tokens used
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2 text-sm">
                <span className="size-2 rounded-full bg-success animate-pulse" />
                <span className="text-success">Running</span>
                <span className="text-muted-foreground ml-auto font-mono text-xs">
                  main &middot; a1b2c3d
                </span>
              </div>
            </CardContent>
          </Card>

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
      <Section title="Status Indicators">
        <div className="space-y-3 max-w-md">
          <div className="flex items-center gap-3 px-3 py-2 rounded-md bg-card border border-border">
            <span className="size-2 rounded-full bg-success animate-pulse" />
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
        </div>
      </Section>

      {/* ── Keyboard Shortcuts ── */}
      <Section title="Keyboard Shortcuts">
        <div className="space-y-1.5 max-w-sm text-sm">
          {[
            ["New session", "Ctrl", "N"],
            ["Stop session", "Ctrl", "C"],
            ["Open repository", "Ctrl", "O"],
            ["Command palette", "Ctrl", "K"],
          ].map(([label, ...keys]) => (
            <div
              key={label}
              className="flex items-center justify-between px-2.5 py-1.5 rounded-md hover:bg-card/60 transition-colors"
            >
              <span>{label}</span>
              <span className="flex items-center gap-1">
                {keys.map((key, i) => (
                  <span key={key} className="flex items-center gap-1">
                    {i > 0 && (
                      <span className="text-muted-foreground/40 text-xs">
                        +
                      </span>
                    )}
                    <kbd>{key}</kbd>
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
              [4, "Card padding, section gap"],
              [6, "Group spacing"],
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
      <Section title="Elevation">
        <p className="text-sm text-muted-foreground mb-4">
          Elevation is conveyed through border intensity and background
          lightness shifts rather than drop shadows. Reserve box-shadow for
          popovers and dropdowns only.
        </p>
        <div className="flex flex-wrap gap-4">
          <div className="space-y-2 text-center">
            <div className="size-20 rounded-md bg-background border border-transparent" />
            <code className="text-xs text-muted-foreground block">Level 0</code>
            <span className="text-[10px] text-muted-foreground/50">
              Background
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
          <div className="flex flex-col items-center gap-1">
            <Play className="size-5" />
            <span className="text-xs">Play</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <Square className="size-5" />
            <span className="text-xs">Stop</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <RotateCcw className="size-5" />
            <span className="text-xs">Retry</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <Terminal className="size-5" />
            <span className="text-xs">Terminal</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <GitBranch className="size-5" />
            <span className="text-xs">Branch</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <FolderOpen className="size-5" />
            <span className="text-xs">Folder</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <Settings className="size-5" />
            <span className="text-xs">Settings</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <Zap className="size-5" />
            <span className="text-xs">Quick</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <ChevronRight className="size-5" />
            <span className="text-xs">Chevron</span>
          </div>
        </div>
      </Section>

      {/* ── Usage patterns ── */}
      <Section title="Patterns">
        <div className="space-y-4 max-w-2xl">
          {/* List item pattern */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
              List item
            </p>
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-md bg-card border border-border hover:border-primary/30 hover:bg-card/80 transition-colors cursor-pointer group">
              <FolderOpen className="size-4 text-muted-foreground group-hover:text-primary transition-colors" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">my-project</div>
                <div className="text-xs text-muted-foreground truncate">
                  /home/user/repos/my-project
                </div>
              </div>
              <Badge variant="success" className="shrink-0">
                3 active
              </Badge>
              <ChevronRight className="size-4 text-muted-foreground group-hover:text-foreground transition-colors" />
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
        </div>
      </Section>
    </main>
  );
}
