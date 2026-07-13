# Design-Rule Compliance vs. Compilability in the CrowdCode Corpus

*Analysis artifact for the DesignFix study. Generated 2026-07-12.*
*Subject codebase: `CrowdCoding-ActiveDocumentation` (CrowdCode / "CrowdCoding3") — Google App Engine (Java 7) + Objectify datastore + AngularJS/Firebase.*
*Rule set: the 15 design rules in `ruleTable.json` (indices 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17).*
*Toolchain used for all compile evidence: JDK 8 (Temurin 8u492), the Eclipse Compiler for Java (ECJ 3.14, the same compiler the study runner uses), and the GAE 1.9.98 `dev_appserver` for runtime evidence.*

---

## Key finding (citable summary)

> **Design-rule compliance and compilability are two independent properties.** With a single exception (Rule 2), a class can violate any of these design rules and still compile, and — conversely — a change that *satisfies* a rule can still break the build. The lone exception is **Rule 2 ("Commands must implement `execute`")**, whose violation is inseparable from a compile error because it coincides with a Java language invariant (unimplemented abstract method). Consequently, verifying that a design-rule fix is correct requires **two independent checks — rule-compliance *and* buildability — and passing one implies nothing about the other.**

This is precisely why the study's success criterion is *"violation resolved **AND** program still builds/runs."* The two gates are orthogonal for 14 of the 15 rules.

---

## 1. The two properties are orthogonal (both directions demonstrated)

We observed **both** off-diagonal cases directly in the corpus, which establishes independence:

**(a) Compliant but does *not* compile.** `dto/ajax/microtask/submission/ImplementBehaviorDTO.java` carries an applied fix (a file comment states *"Added a zero-argument constructor with an empty body to follow the design rule"* — i.e., it now **satisfies Rule 9**, "DTOs must have a zero-argument constructor"). Yet the same edit deleted the file's `package` declaration and all `import` statements, so the class **fails to compile**. Rule satisfied, build broken.

**(b) Violating but *does* compile.** We took the corpus from **48 compile errors to 0** while leaving **every seeded design-rule violation in place** (Section 3). Violations present, build clean.

Because both (a) and (b) exist, neither property determines the other.

---

## 2. What actually caused the 48 compile errors (non-design breakage)

The original corpus did not compile (48 ECJ errors). Crucially, **none of the errors were caused by the design-rule violations themselves.** Every error traced to ordinary, non-design breakage:

| Root cause | File(s) | Nature |
|---|---|---|
| Stripped `package` + `import`s | `ImplementBehaviorDTO.java` | collateral of an applied fix |
| Missing `import` | `Test.java` (`FunctionDTO`), `MicrotaskCommand.java` (`Function`, `Review`) | missing imports |
| Corruption | `AchievementManager.java` (a stray garbage token `adsasda…`) | non-code text |
| Type error | `MicrotaskCommand.java` (`Key<Function>` where a `Ref<Function>` is required) | wrong type |
| Constructor arg-count mismatch | `Function.java` (`new Test(...)`, `new ADT(...)`) | call sites not updated to the current constructor signatures |

Fixing only these — **7 files, zero changes to any annotation, pattern, or design-relevant construct** — produced a clean build (`compile-strict` exit 0, 167 classes emitted) with all violations intact.

---

## 3. The design-rule violations that remained present in the clean build

After reaching 0 errors, the following violations were still present and detectable:

| Rule | Violation kept | Location | Compiles? |
|---|---|---|---|
| **12** — `@Entity` classes must have an `@Id` field | `Worker` is an `@Entity` with **no** `@Id` field | `Worker.java:40` (`private String userid;`, `@Id` absent) | ✅ |
| **13** — `@Subclass` classes must be indexed | `@Subclass(index=true)` commented out | `ImplementBehavior.java:20`, `Question.java:27` | ✅ |
| **3 / (Entity annotations)** | `@Entity` / `@Id` commented out on `Achievement` | `Achievement.java:28,32` | ✅ |
| **6 / 7** — inter-artifact communication / artifact creation must be indirected through a `Command` | `Function` constructs artifacts directly (`new Test(...)`, `new ADT(...)`) instead of via a Command | `Function.java:166–167` | ✅ |

**Interpretation.** Design rules govern *annotations, registration, structural patterns, and call shape*. The Java compiler checks none of these, so removing an `@Entity`/`@Id`/`@Subclass` annotation, or calling a constructor directly, leaves valid, compilable Java. The violation is visible to the srcML/XPath rule checker but invisible to the compiler.

> **Note on how violations are *seeded* vs. what the rule *is*.** Some violations were originally introduced by deleting more than the rule requires — e.g., Rule 12 was seeded by commenting out Worker's **entire** `userid` field, which broke compilation because `userid` is referenced ~20×. That compile error is an artifact of the *seeding method*, not of the rule: re-expressing the violation minimally (declare the field, omit only the `@Id` annotation — `private String userid;`) keeps the Rule-12 violation and compiles. The rule itself is compile-neutral; only an over-broad edit made it look otherwise.

---

## 4. The exception: Rule 2 is compiler-coupled

**Rule 2 — "Commands must implement `execute`"** is the single rule whose violation *necessarily* produces a compile error, because it maps directly onto Java's abstract-method enforcement.

The Command hierarchy:

```java
// Command.java:3-4
public abstract class Command {
    public abstract void execute(String projectId);            // abstract
}

// MicrotaskCommand.java:20,64,78  (same shape in FunctionCommand.java:11,88,102, etc.)
public abstract class MicrotaskCommand extends Command {
    public void execute(String projectId) { /* … calls typed execute */ }
    public abstract void execute(Microtask microtask, String projectId);   // typed, ABSTRACT
}

// each concrete command is an inner class:
protected static class Submit extends MicrotaskCommand {
    public void execute(Microtask microtask, String projectId) { … }        // MUST implement
}
```

Because every family command class (`MicrotaskCommand`, `FunctionCommand`, `ADTCommand`, …) re-declares the typed `execute` as **`abstract`**, a *concrete* command that omits `execute` is a concrete class with an unimplemented abstract method — a hard compile error.

### 4.1 Empirical verification (isolated 4-class reproduction, `javac` 8)

| Case | Source | `javac` result |
|---|---|---|
| **Rule-2 violated** | `class Submit extends MicrotaskCommand { }` (no `execute`) | ❌ `error: Submit is not abstract and does not override abstract method execute(Object,String) in MicrotaskCommand` |
| **Rule-2 compliant** (control) | `…{ public void execute(Object m, String p){} }` | ✅ compiles (exit 0) |
| **"Abstract" dodge** | `abstract class Submit …` (skips `execute`); then `new Submit()` | ❌ `error: Submit is abstract; cannot be instantiated` |

The third case matters: the *only* structural way to omit `execute` and still compile is to make the command `abstract` — but an abstract command cannot be instantiated, so its factory's `new Submit(...)` fails to compile instead. **There is no way to keep a functioning command that violates Rule 2 and compiles.** For Rule 2, "violates the rule" and "fails to compile" are the same condition.

### 4.2 Two boundary conditions on this claim

- **Reading of "causes a compile error."** The statement above uses the strict reading — *violation necessarily implies a compile error*. Under a looser reading — *a violation can incidentally coincide with a compile error* — Rule 12 also did in the raw corpus (Worker), but only because of the over-broad seeding edit (Section 3 note), not intrinsically.
- **Rule 2's XPath is broader than its description.** The rule's `quantifierXPathQuery` (`//src:unit/src:class/src:block/src:class`) flags *any* inner class in `commands/` lacking an `execute` method, not strictly a "subclass of `Command`." A non-Command helper inner class without `execute` would therefore be *flagged by the checker yet compile fine* — a checker artifact, not a genuine Rule-2 violation. For any real Command subclass the coupling holds.

---

## 5. Per-rule classification

| Rule | Title | Minimal violating form | Compiler-coupled? | Evidence |
|---|---|---|---|---|
| 1 | Command static methods construct a Command subclass | factory returns `null` / other | No | argued (valid Java) |
| **2** | **Commands must implement `execute`** | concrete command omits `execute` | **Yes** | **`javac`, §4.1** |
| 3 | Artifact subclasses need `@Entity` | drop `@Entity` | No | empirical (Achievement) |
| 4 | Microtasks need a `Ref` to their Artifact | drop `@Parent`/`@Load` (keep field) | No | argued |
| 6 | Inter-artifact communication via Command | direct method call | No | empirical (Function) |
| 7 | Artifact creation via Command | direct `new Artifact(...)` | No | empirical (Function §3) |
| 8 | No `ObjectMapper` in an entity | use `ObjectMapper` in an entity | No | argued |
| 9 | DTOs need a zero-arg constructor | remove the no-arg ctor | No | empirical (ImplementBehaviorDTO §1) |
| 10 | `save()` immediately followed by `now()` | omit `.now()` | No | argued |
| 11 | `@Entity` registered in `CrowdServlet` | omit the `register()` call | No | argued |
| 12 | `@Entity` has an `@Id` field | drop the `@Id` (keep field) | No | empirical (Worker §3) |
| 13 | `@Subclass` indexed (`index=true`) | `@Subclass` without `index=true` | No | empirical (ImplementBehavior/Question) |
| 14 | `@Entity` has a zero-arg constructor | remove the no-arg ctor | No | argued |
| 16 | Commands not publicly visible | make the command `public` | No | argued |
| 17 | Commands persist all given parameters | ignore a constructor param | No | argued |

"Compiler-coupled" = the Java compiler rejects the violating (functioning) form. Only Rule 2 is coupled; it is the one rule that overlaps a language-level invariant (abstract-method implementation).

---

## 6. A third, separate axis: compiles ≠ runs

Compilability does not imply the program *runs*. Two of the kept violations are **compile-clean but runtime-fatal** under this stack:

- **Rule 12 (Worker without `@Id`).** Compiles, but Objectify rejects the entity at registration on the first request:
  `java.lang.IllegalStateException: There must be an @Id field (String, Long, or long) for com.crowdcoding.entities.Worker` → **HTTP 500 on every application page** (the local datastore admin console at `/_ah/admin` still returns 200, since it does not load application entities).

This yields a **three-level distinction** useful when framing implications: a violation may be *(i)* compile-neutral and runtime-neutral, *(ii)* compile-neutral but runtime-fatal (e.g., Rule 12, Rule 14), or *(iii)* compile-fatal (only Rule 2). The study's *"builds/runs"* criterion spans levels (ii) and (iii); the srcML/XPath check is independent of both.

---

## 7. Implications for fix-validation (DesignFix)

1. **Two orthogonal gates are required.** Rule-compliance (srcML/XPath over `ruleTable.json`) and buildability (`run.cmd compile-strict`, ECJ non-zero exit) are independent for 14 of 15 rules. Passing one says nothing about the other — hence the *"violation resolved AND still builds/runs"* success criterion.
2. **A fix can satisfy the rule and still break the build.** Demonstrated by the `ImplementBehaviorDTO` case (Rule 9 satisfied, `package`/imports dropped → build broken). A compile gate after each applied fix is therefore necessary, not redundant.
3. **Rule 2 is redundantly enforced by the compiler.** For Rule 2, `compile-strict` alone catches the violation before any rule check runs; a "violation-present, compiles-cleanly" baseline for a *functioning* command is not constructible. Baselines for the other 14 rules can hold the violation while compiling cleanly.
4. **Buildable ≠ runnable.** Some compile-clean violations (Rule 12, Rule 14) still abort at boot. If a baseline or a fixed program must *run* (not merely compile), those runtime-fatal rules need separate handling.

---

## Appendix — reproduction

- **Compile gate (clean build with violations present):** from `F:\CrowdCoding-ActiveDocumentation\CrowdCoding-Runner`, run `.\run.cmd compile-strict` → `0 error(s)`, exit code `0`.
- **Rule-2 `javac` reproduction (§4.1):** a 4-class file mirroring `Command → <Family>Command (abstract typed execute) → concrete command`; compile the "no-`execute`" variant, the "with-`execute`" variant, and the "abstract-then-`new`" variant with `javac` (any JDK; behavior is language-level).
- **Runtime evidence (§6):** launch `dev_appserver` via `.\run.cmd`, request `/` → HTTP 500 (`ExceptionInInitializerError` → `IllegalStateException: There must be an @Id field … for … Worker`).
- **Source anchors:** `Command.java:3–4`; `MicrotaskCommand.java:20,64,78`; `FunctionCommand.java:11,88,102`; `Worker.java:40`; `Achievement.java:28,32`; `ImplementBehavior.java:20`; `Question.java:27`; `Function.java:166–167`; `ImplementBehaviorDTO.java` (missing `package`/imports).
- **Rule definitions:** `ruleTable.json` (indices as cited).
