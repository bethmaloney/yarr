---
name: brainstorming
description: "You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation."
---

# Brainstorming Ideas Into Designs

## Overview

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

Start by understanding the current project context, then ask questions one at a time to refine the idea. Once you understand what you're building, present the design in small sections (200-300 words), checking after each section whether it looks right so far.

## The Process

**Understanding the idea:**
- Check out the current project state first (files, docs, recent commits)
- Ask questions one at a time to refine the idea
- Prefer multiple choice questions when possible, but open-ended is fine too
- Only one question per message - if a topic needs more exploration, break it into multiple questions
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**
- Propose 2-3 different approaches with trade-offs
- Present options conversationally with your recommendation and reasoning
- Lead with your recommended option and explain why

**Presenting the design:**
- Once you believe you understand what you're building, present the design
- Break it into sections of 200-300 words
- Ask after each section whether it looks right so far
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

## After the Design

**Documentation:**
- Write the validated design to `docs/plans/YYYY-MM-DD-<topic>-design.md`
- Commit the design document to git

**Implementation (if continuing):**
- Ask: "Ready to set up for implementation?"

**Implementation Plan:**
After the user confirms, generate an implementation plan and append it to the same design document. This plan breaks the design into discrete, ordered tasks that can be executed one at a time.

Before writing the plan, explore the codebase to find existing files that match the patterns needed (controllers, tests, UI components, query hooks, etc.). Reference these as `**Pattern reference:**` so the implementer knows exactly what to mimic.

For each task in the plan, include:

1. **Task heading** — `### Task N: Short title` with a one-line description
2. **Files to create/modify** — exact file paths
3. **Pattern reference** — path to an existing file in the codebase that demonstrates the pattern to follow
4. **Details** — bullet points covering the key implementation decisions, APIs to use, and conventions to follow
5. **Checklist** — `- [ ]` items for each discrete piece of work within the task, including a verification step (build, typecheck, test run)
6. **Separator** — `---` between tasks

End the plan with a **Progress Tracking** table:

```markdown
### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Short description | Not Started |
| 2 | Short description | Not Started |
```

**Task sizing — keep tasks small:**
- Each task should do ONE logical thing. If you find yourself writing "and" in the task title, it's probably two tasks.
- Prefer many small tasks over fewer large ones. A task with 6+ checklist items should likely be split.
- DTOs, controllers, mappers, and validators should be separate tasks even if they're in the same folder.
- Each endpoint or API method can be its own task when the logic is non-trivial.
- UI components, query hooks, page composition, and route wiring should all be separate tasks.
- Unit and integration tests should be included within the task for the code they test — not split into a separate task.
- E2E tests should be their own task at the end of the plan, when appropriate.
- Every task must end with a verification step (build, typecheck, lint, or test run).

## Key Principles

- **One question at a time** - Don't overwhelm with multiple questions
- **Multiple choice preferred** - Easier to answer than open-ended when possible
- **YAGNI ruthlessly** - Remove unnecessary features from all designs
- **Explore alternatives** - Always propose 2-3 approaches before settling
- **Incremental validation** - Present design in sections, validate each
- **Be flexible** - Go back and clarify when something doesn't make sense
- **Concrete plans** - Implementation plans reference real files and patterns from the codebase, not abstract descriptions
