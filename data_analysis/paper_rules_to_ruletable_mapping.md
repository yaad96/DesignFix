# Mapping the DesignFix Paper's Rule Mentions to CrowdCode's `ruleTable.json`

*Analysis artifact for the DesignFix revision. Generated 2026-07-13.*
*Sources: `First_Submission.pdf` (11 pages — the container reports 68, but `pypdf` page_count = 11; content runs title → References) with all quotes verified verbatim via `pdftotext`, and the 15-rule `ruleTable.json` at `F:\CrowdCoding-ActiveDocumentation\ruleTable.json` (indices 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17; gaps at 5 and 15).*

---

## Purpose

The paper's user study (§VI) refers to design rules only by *constraint and affected files* — never by rule number/ID — and provides no per-participant rule-assignment table. This document (1) inventories every rule reference in the paper, (2) maps each to its probable rule in `ruleTable.json` with confidence and rationale, and (3) reconstructs the probable 8-rule study set.

---

## A. Rules tied to participants in the user study (§VI-C, §VI-D, §VIII — pp. 8–10)

| ID | Participant & condition | Rule as the paper describes it | Verbatim anchor (page) |
|---|---|---|---|
| U1 | **P3, unassisted (failed)** | Entity registration; violation in `CrowdServlet.java`, P3 wrongly edited `Question.java`/`Project.java` for ~15 of 19 min | "the actual violation was in CrowdServlet.java" (p.8) |
| U2 | **P3, assisted (succeeded, 12 min)** | A DTO-layer rule | "The explanation tied the rule to the DTO layer that already exists here, which made the change feel justified." (p.9) |
| U3 | **P2, assisted** | A Command factory-pattern rule | "The explanation matched the factory pattern in this codebase, not just generic advice." (p.9) |
| U4 | **P9, both conditions** | Command/Factory rule involving the `AddCallee` inner class; unassisted P9 was "getting lost jumping between the Command files" and hit the time limit; Table III lists P9 under *Wrong method signature* | "It automatically opened the Factory class on the left and the fix on the right… I could verify the AddCallee signature side-by-side." (p.9) |
| U5 | **P14, assisted (Failure Case 2)** | The "command indirection rule"; the LLM's incorrect patch "suggested a direct call which was a violation"; recovery keywords "command indirection," "caller/callee"; correct pattern found in `FunctionCommand.java` | "The tool actually gave me a bad patch - it suggested a direct call which was a violation." (pp.9–10) |
| U6 | **P8, assisted (Failure Case 1 — only assisted failure)** | A zero-argument-constructor rule; correct fix pasted in the wrong location | "I saw the one-line constructor change, compared it in one second, and hit accept." (p.10) |

Participants **P1, P4, P7, P10** appear only via Table III error categories (*Misunderstood rule*, *Syntax/compile errors*, *Wrong method signature*, *Partial fix*) with **no rule named**. **P5, P11, P13** quotes are rule-agnostic (workflow/cognition themes).

> Note on U5: the "direct call" was **DesignFix's suggested fix**, not the seeded violation — the seeded violation shown to P14 was a command-indirection violation whose *repair* the LLM botched by proposing another direct call. (Relevant when recreating the scenario.)

## B. Rules named elsewhere in the paper (not participant-tied)

| ID | Location | Rule as printed |
|---|---|---|
| G1 | §II-A structure example (p.2) | "IF a class is a subclass of Microtask THEN it must have a field representing a reference to its owning Artifact" |
| G2 | §II-B Listing 1 (p.2) | `MutableLiveData` must not be exposed publicly from ViewModels — **Android rule set, not CrowdCode** |
| G3 | §II-B Listing 2 (p.2) | "Artifact subclasses must be annotated @Entity" (`@Entity @Subclass(index=true) public class ADT extends Artifact`) |
| G4 | §II-B Listing 3 (p.2) | "Command static methods must construct the right Command subclass" (`FunctionCommand` example) |
| G5 | §IV-D walkthrough, Figs. 2–3 (p.5) | "a concrete example from the CrowdCode codebase, where a DTO class is missing a required zero-argument constructor" |
| G6 | §V-A dataset (pp.5–6) | "CrowdCode: … 8 design rules covering command patterns, entity persistence, and artifact relationships" + "Android Architectural Rules: a set of 7 rules" (no IDs given) |
| G7 | §VI-A tasks (p.7) | "rules covering command patterns, persistence, and architectural constraints, organized into pairs of comparable complexity" — four rule sets; within a set, one rule per condition, counterbalanced |

---

## C. Mapping to `ruleTable.json`

| Paper mention | Probable rule(s) | Confidence | Rationale |
|---|---|---|---|
| U1 — P3 CrowdServlet registration | **Rule 11** — "@Entity classes must be registered in the CrowdServlet class" | **Exact** | Rule 11's constraint XPath targets `ObjectifyService.register` inside `CrowdServlet`; P3's failure mode (editing entity classes when the fix belongs in `CrowdServlet.java`) is this rule's signature confusion |
| U2 — P3 "DTO layer" | **Rule 8** — "Objects sent to an external service should have a corresponding DTO (no `ObjectMapper` in Entity)"; alt **Rule 9** | High (8) / plausible (9) | "Tied the rule to the DTO layer *that already exists*" matches Rule 8's fix (route serialization through existing DTOs). Under Rule 9 the violating class already *is* a DTO, making that connection trivial |
| U3 — P2 factory pattern | **Rule 1** — "All Microtask commands must be handled by Command subclasses"; alt **Rule 17** | High | Rule 1 *is* the factory-pattern rule (quantifier checks `return new <Subclass>(…)` in static methods) and is Listing 3 (G4) verbatim |
| U4 — P9 AddCallee signature | **Rule 17** — "Commands should persist all data they are given" or **Rule 1** | Medium (either) | `AddCallee` is a `FunctionCommand` inner class (FunctionCommand.java:199) with static factory `addCallee` (line 35). Rule 17 checks constructor params vs stored fields — fits "verify the AddCallee signature" and P9's *Wrong method signature* error; Rule 1's fix (factory matching the ctor) also fits |
| U5 — P14 command indirection | **Rule 6** — "Communication between artifacts should be indirected through a Command"; sibling **Rule 7** (creation) | **High (6)** | "Caller/callee" keywords + correct pattern in `FunctionCommand.java` = the caller/callee notification Commands (`addCaller`/`addCallee`/`calleeChangedInterface`/`calleeBecomeDeactivated`). Rule 7 governs construction, not "direct call" communication |
| U6 — P8 one-line constructor | **Rule 9** — "DTOs must have a zero-argument constructor" or **Rule 14** — "@Entity classes must have a zero-argument constructor" | High (9/14) | Both are one-line ctor fixes. The paper's own UI walkthrough (G5) uses the Rule 9 DTO case; the corpus's `ImplementBehaviorDTO.java` carries an applied Rule-9 fix banner |
| G1 — Microtask→Artifact reference | **Rule 4** — "Microtasks must have a reference to the Artifact that it belongs to" | **Exact** | Word-for-word the same IF/THEN |
| G3 — Artifact @Entity (ADT listing) | **Rule 3** — "Artifacts should be marked as a data region with an @Entity annotation" (syntax also involves **Rule 13**) | **Exact** | The listing is Rule 3's constraint; `@Subclass(index=true)` is Rule 13's condition. The corpus's seeded `//@Subclass` in `ADT.java` is this listing violated |
| G4 — Command static factories | **Rule 1** | **Exact** | Same text, same `FunctionCommand` example |
| G5 — DTO missing zero-arg ctor | **Rule 9** | **Exact** | The UI figures show this rule's description and violation |
| G2 — MutableLiveData | — (Android rule set; see `F:\AndroidArchitectureRules`) | n/a | Not in CrowdCode's table |

**Rules never mentioned in the paper:** Rule 2 (Commands must implement `execute`), Rule 10 (`save()` → `now()`), Rule 12 (`@Entity` must have `@Id`), Rule 13 (standalone), Rule 16 (Commands not public), and Rule 14 unless it is P8's rule.

---

## D. Reconstructing the study's 8 rules (4 pairs)

The paper never enumerates the study rules. Three independent constraints triangulate a probable set:

1. **Anecdotes (§A above)** require Rules 11 (P3), a DTO rule 8/9 (P3), factory rule 1/17 (P2, P9), and indirection rule 6 (P14), plus a zero-arg-ctor rule 9/14 (P8).
2. **Eval I (G6)**: CrowdCode contributed **8 rules** = 4 pairs × 2 (§VI-A).
3. **The Cline-baseline harness's "hardest six"** rules are **6, 17, 7, 3, 1, 8** — presumably drawn from the study set.

Union of {1, 3, 6, 7, 8, 17} (hardest six) + 11 (required by U1) + 9 (required by G5/U6) = **exactly 8**:

> **Probable study set: Rules 1, 3, 6, 7, 8, 9, 11, 17**, plausibly paired as:
> - **(6, 7)** — command indirection: communication vs. creation *(P14's set)*
> - **(1, 17)** — command patterns: factory construction vs. parameter persistence *(P9's set — both of his conditions were Command-file tasks)*
> - **(11, 8 or 9)** — registration + DTO layer *(P3's set: Rule 11 unassisted, DTO rule assisted)*
> - **remaining pair from (3, 9/8)** — artifact annotation + the leftover DTO/ctor rule

Confidence: **moderate** for the set membership, **lower** for the exact pairings — "pairs of comparable complexity" need not be same-category pairs.

---

## E. Caveats / revision-relevant observations

1. **Rule-count discrepancy.** The paper says CrowdCode has **8** design rules (§V-A), but the current `ruleTable.json` holds **15** CrowdCode rules. The table has evidently grown post-study (file mtime 2025-04-15); a reviewer could probe this. State which 8 were used, or note the table's evolution.
2. **Rules 12 and 13 are not paper rules.** Current revision experiments (`data/` runs for rules 3, 9, 11, 12, 13) include two rules the paper's study never mentions — fine for the agentic-baseline work, but they should not be presented as replications of study tasks.
3. **No per-participant assignment table exists in the paper.** All participant-rule links above are inferred from qualitative anecdotes; only U1 (P3→Rule 11), U5 (P14→Rule 6), and the exact-match general mentions are near-certain.
4. **Rule 6 checker semantics.** The `ruleTable.json` XPath for Rule 6 operationalizes a narrower constraint than its prose (see the Rule-6 engine analysis: detectable violations live in *Command inner classes* constructing foreign entities; direct calls inside entity files are structurally invisible to the checker). Relevant when recreating P14's scenario or discussing what the checker measures.
5. **Missing indices 5 and 15** in `ruleTable.json` suggest the original numbering had ≥17 rules with two later removed.
