Complete picture assembled. Here's Rule 13.

## The fixes (baseline: bare `@Subclass`, no `index=true`)

**DesignFix** — minimal, exact:
```java
@Subclass(index=true)
public class ADT extends Artifact
```

**Cline** — added two annotations, but not the right one:
```java
@Entity
@Subclass          // ← still no index=true
@Index
public class ADT extends Artifact
```

## Correctness
Rule 13's constraint is `@Subclass(index=true)` — the `index=true` must be an **argument on `@Subclass`**.

- **DesignFix: PASS.** Changed `@Subclass` → `@Subclass(index=true)`, copying the example (`Comment.java`). Clean, correct, minimal.
- **Cline: FAIL.** It left `@Subclass` bare and instead added a class-level `@Index` plus a redundant `@Entity`. The checker still sees no `index=true` on `@Subclass`, so **ADT remains a Rule 13 violation**. Worse, `@Index` is Objectify's *field*-level annotation — meaningless on a class — and `@Entity` is the same redundant misfire from the Rule 3 run.

## Why Cline failed — even though the description said "index=true"
Rule 13's description literally says *"it needs to be indexed ('index=true')."* So Cline knew the *concept* — but not the **syntax**: that `index=true` is an argument to `@Subclass`, not a standalone annotation. Lacking the example, it reached for the plausible-sounding `@Index` annotation and hedged with `@Entity`. DesignFix's example (`Comment.java` → `@Subclass(index=true)`) handed it the exact syntax.

Notably, Cline **explored heavily (11 turns, 21K input tokens) and still got it wrong** — because the missing piece wasn't *where* to fix or *what concept*, it was the precise annotation syntax, which lives in a passing sibling (e.g. `Function.java`) that Cline never consulted. Exploration of the violating file alone can't surface it.

## Cost / tokens
| | DesignFix run_01 | Cline run_01 |
|---|---|---|
| Turns / calls | 2 | 11 |
| Fresh in / out | 6,436 / 2,295 | 20,940 / 1,887 |
| Cached | 0 | 165,248 |
| **Cost** | **$0.0390** | **$0.2778** |
| Checker | ✅ pass | ❌ fail |

Cline cost **~7.1×** more — the worst ratio yet — and still failed. Cached re-sends dominate (~$0.207 of $0.278) across 11 turns.

## Where this sits across the three rules
- **Rule 3** (misleading description): DesignFix ✅ via example, Cline ❌.
- **Rule 13** (concept in description, but not the syntax): DesignFix ✅ via example, Cline ❌ — even with "index=true" spelled out.
- **Rule 12** (faithful description, standard `@Id` field): Cline ✅ (exploration found the `userid` key), DesignFix ✅-checker-but-❌-semantics.

The through-line: **the example carries exact annotation syntax that descriptions omit** (wins Rule 3 & 13 for DesignFix), while **agentic exploration helps only when the fix hinges on codebase-specific context** (wins Rule 12 for Cline). More Cline turns ≠ better — Rule 13 was its most expensive run and a failure.
