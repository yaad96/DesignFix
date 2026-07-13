Cline run_02 repeated its **correct** fix — same as run_01:
```java
@Entity
public class Worker
{
	@Parent Key<Project> project;
	private String nickname;
	@Id
	private String userid;      // ← annotated the existing natural key again
	...
```

So it annotated the existing `userid` field with `@Id` — matching Worker's `Key.create(project, Worker.class, userid)` semantics. **Correct, again.**

## The headline: the inversion is now reproducible on *both* sides
You now have two independent (non-deterministic) runs of each tool on the same Worker/Rule 12 violation:

| | Fix | Checker | Semantics |
|---|---|---|---|
| **DesignFix** r1 | `@Id Long id` | ✅ | ❌ breaks key lookups |
| **DesignFix** r2 | `@Id Long id` | ✅ | ❌ breaks key lookups |
| **Cline** r1 | `@Id String userid` | ✅ | ✅ correct natural key |
| **Cline** r2 | `@Id String userid` | ✅ | ✅ correct natural key |

This is a clean, stable result: **DesignFix is consistently semantically wrong (2/2) and Cline is consistently semantically right (2/2)** on this rule. Neither outcome is a fluke — DesignFix reliably ignores its own String-key example and defaults to a `Long` surrogate; Cline reliably explores `Worker.java`, finds `userid` is the key, and annotates it.

## Cost
| | DesignFix r2 | Cline r2 |
|---|---|---|
| Turns / calls | 2 | 10 |
| Fresh in / out | 9,159 / 3,647 | 21,223 / 2,010 |
| Cached | 0 | 153,088 |
| **Cost** | **$0.0594** | **$0.2645** |

Cline run_02 cost **~4.5×** more (and slightly more than its own run_01's $0.2056 — 10 turns vs 8, cached 153K vs 113K), cached re-sends being ~$0.19 of it. So Cline pays consistently more, but here that exploration consistently buys the correct fix.

## Why this matters for the paper
Rule 12 is your strongest counter-example to the "DesignFix always wins" narrative — and now it's **reproducible on both sides**, which is exactly the reliability rigor you were after. The clean claim: *on a rule where the correct fix depends on codebase-specific key semantics rather than a fixed annotation, the agentic baseline is reliably more correct — at ~4× the cost — while the example-guided tool reliably regresses to a generic pattern.* Pair that with Rules 3 & 13 (where the reverse holds) and you have a nuanced, defensible story.
