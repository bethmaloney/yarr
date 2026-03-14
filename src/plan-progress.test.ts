import { describe, it, expect } from "vitest";
import { parsePlanProgress } from "./plan-progress";
import type { PlanProgress } from "./plan-progress";

describe("parsePlanProgress", () => {
  describe("standard plan with mixed checked/unchecked items", () => {
    it("parses tasks with correct completed/total counts", () => {
      const markdown = `# My Plan

## Task 1: Setup environment
- [x] Install dependencies
- [x] Configure linter
- [ ] Set up CI

## Task 2: Implement feature
- [x] Create component
- [ ] Add tests
- [ ] Write docs
`;

      const result = parsePlanProgress(markdown);

      expect(result).not.toBeNull();
      const progress = result as PlanProgress;
      expect(progress.tasks).toHaveLength(2);

      expect(progress.tasks[0]).toEqual({
        number: 1,
        title: "Setup environment",
        total: 3,
        completed: 2,
      });

      expect(progress.tasks[1]).toEqual({
        number: 2,
        title: "Implement feature",
        total: 3,
        completed: 1,
      });

      expect(progress.totalItems).toBe(6);
      expect(progress.completedItems).toBe(3);
      expect(progress.currentTask).toEqual({
        number: 1,
        title: "Setup environment",
        total: 3,
        completed: 2,
      });
    });

    it("sets currentTask to the first incomplete task (not the first task)", () => {
      const markdown = `## Task 1: Done task
- [x] Step A
- [x] Step B

## Task 2: In progress
- [x] Step C
- [ ] Step D

## Task 3: Not started
- [ ] Step E
`;

      const result = parsePlanProgress(markdown);

      expect(result).not.toBeNull();
      const progress = result as PlanProgress;
      expect(progress.currentTask).toEqual({
        number: 2,
        title: "In progress",
        total: 2,
        completed: 1,
      });
    });
  });

  describe("all items complete", () => {
    it("returns null currentTask when every task is fully complete", () => {
      const markdown = `## Task 1: First thing
- [x] Done A
- [x] Done B

## Task 2: Second thing
- [x] Done C
- [X] Done D
`;

      const result = parsePlanProgress(markdown);

      expect(result).not.toBeNull();
      const progress = result as PlanProgress;
      expect(progress.tasks).toHaveLength(2);
      expect(progress.totalItems).toBe(4);
      expect(progress.completedItems).toBe(4);
      expect(progress.currentTask).toBeNull();
    });

    it("treats uppercase X as checked", () => {
      const markdown = `## Task 1: Stuff
- [X] Item one
- [x] Item two
`;

      const result = parsePlanProgress(markdown);

      expect(result).not.toBeNull();
      const progress = result as PlanProgress;
      expect(progress.completedItems).toBe(2);
      expect(progress.currentTask).toBeNull();
    });
  });

  describe("no checklist items", () => {
    it("returns null when plan has headings but no checklists", () => {
      const markdown = `## Task 1: Overview
Some description text.

## Task 2: Details
More description text.
`;

      const result = parsePlanProgress(markdown);
      expect(result).toBeNull();
    });

    it("returns null for plain text with no headings or checklists", () => {
      const markdown = `Just some plain text
with multiple lines
but no structure.
`;

      const result = parsePlanProgress(markdown);
      expect(result).toBeNull();
    });
  });

  describe("numbered headings without 'Task' prefix", () => {
    it("parses headings like '## 1: Setup' without the Task keyword", () => {
      const markdown = `## 1: Setup
- [x] Install deps
- [ ] Configure

## 2: Build
- [ ] Compile
- [ ] Test
`;

      const result = parsePlanProgress(markdown);

      expect(result).not.toBeNull();
      const progress = result as PlanProgress;
      expect(progress.tasks).toHaveLength(2);

      expect(progress.tasks[0]).toEqual({
        number: 1,
        title: "Setup",
        total: 2,
        completed: 1,
      });

      expect(progress.tasks[1]).toEqual({
        number: 2,
        title: "Build",
        total: 2,
        completed: 0,
      });

      expect(progress.totalItems).toBe(4);
      expect(progress.completedItems).toBe(1);
      expect(progress.currentTask).toEqual({
        number: 1,
        title: "Setup",
        total: 2,
        completed: 1,
      });
    });

    it("handles various separator styles between number and title", () => {
      const markdown = `## 1: Colon sep
- [x] Done

## 2 — Em dash sep
- [ ] Todo

## 3 - Hyphen sep
- [x] Done
`;

      const result = parsePlanProgress(markdown);

      expect(result).not.toBeNull();
      const progress = result as PlanProgress;
      expect(progress.tasks).toHaveLength(3);
      expect(progress.tasks[0].title).toBe("Colon sep");
      expect(progress.tasks[1].title).toBe("Em dash sep");
      expect(progress.tasks[2].title).toBe("Hyphen sep");
    });

    it("handles heading with just a number and whitespace title", () => {
      const markdown = `## 1
- [x] Something
- [ ] Another
`;

      const result = parsePlanProgress(markdown);

      expect(result).not.toBeNull();
      const progress = result as PlanProgress;
      expect(progress.tasks).toHaveLength(1);
      expect(progress.tasks[0].number).toBe(1);
      expect(progress.tasks[0].title).toBe("");
    });
  });

  describe("h3 headings (### Task N)", () => {
    it("parses ### Task headings the same as ## Task headings", () => {
      const markdown = `# Plan

### Task 1: Parse stuff
- [x] Add struct
- [x] Add field
- [ ] Add test

### Task 2: Wire it up
- [ ] Emit event
- [ ] Handle in store
`;

      const result = parsePlanProgress(markdown);

      expect(result).not.toBeNull();
      const progress = result as PlanProgress;
      expect(progress.tasks).toHaveLength(2);
      expect(progress.tasks[0]).toEqual({
        number: 1,
        title: "Parse stuff",
        total: 3,
        completed: 2,
      });
      expect(progress.tasks[1]).toEqual({
        number: 2,
        title: "Wire it up",
        total: 2,
        completed: 0,
      });
      expect(progress.totalItems).toBe(5);
      expect(progress.completedItems).toBe(2);
      expect(progress.currentTask?.number).toBe(1);
    });
  });

  describe("malformed and empty input", () => {
    it("returns null for empty string", () => {
      expect(parsePlanProgress("")).toBeNull();
    });

    it("returns null for whitespace-only input", () => {
      expect(parsePlanProgress("   \n\n  \n")).toBeNull();
    });

    it("returns null for headings that don't match the number pattern", () => {
      const markdown = `## Introduction
- [x] Some item

## Conclusion
- [ ] Another item
`;

      const result = parsePlanProgress(markdown);
      expect(result).toBeNull();
    });

    it("excludes tasks with zero checklist items from the result", () => {
      const markdown = `## Task 1: Has items
- [x] Item A
- [ ] Item B

## Task 2: No items
Just a description.

## Task 3: Also has items
- [ ] Item C
`;

      const result = parsePlanProgress(markdown);

      expect(result).not.toBeNull();
      const progress = result as PlanProgress;
      expect(progress.tasks).toHaveLength(2);
      expect(progress.tasks[0].number).toBe(1);
      expect(progress.tasks[1].number).toBe(3);
      expect(progress.totalItems).toBe(3);
      expect(progress.completedItems).toBe(1);
    });
  });

  describe("indented checklist items", () => {
    it("counts indented checklist items under a task", () => {
      const markdown = `## Task 1: Nested items
- [x] Top-level done
  - [ ] Indented not done
    - [x] Double-indented done
`;

      const result = parsePlanProgress(markdown);

      expect(result).not.toBeNull();
      const progress = result as PlanProgress;
      expect(progress.tasks).toHaveLength(1);
      expect(progress.tasks[0].total).toBe(3);
      expect(progress.tasks[0].completed).toBe(2);
    });
  });
});
