# **What it takes to get DesignFix accepted**

**The bottom line:** Your decision is Major Revision, and the path to acceptance runs through the metareview's three mandates — only **one of which requires a new experiment** (the agentic baseline). Everything else is writing, re-analysis, and artifact packaging. The bar is set by the metareview, but R1 (weak reject) and R3 (reject) will re-review against their original complaints, so their "reasons to not accept" effectively count as critical too. R1 rejects on *checkability*, not substance — every one of their objections is a text or artifact fix. R2 (weak accept) is the cheapest to retain. R3 is the hardest, and the mandated experiment is aimed squarely at their concern.

One thing to be aware of before anything else: **your rebuttal contains a misstatement that will be checked.** It says *"As we describe in Section VI-A, participants without DesignFix used VSCode and were free to use conversational LLMs…"* — but the submitted paper's Section VI-A says only "using only the design rule checker" and never mentions VSCode, IDEs, or any LLM policy. R2 asked for exactly this and will look for it. If that text isn't in the revision, it will read as bad faith.

---

## **🔴 Acceptance-critical**

### **A. The metareview's three mandates (non-negotiable)**

1. **Run the agentic baseline experiment (the only unavoidable new experiment).** Have an AI agent — Claude Code, since both R3 and the metareview name it — perform the *same tasks your 14 human participants did* on CrowdCode, given the same inputs (codebase checkout \+ the rule checker's violation report), with no new human participants. Run 3–5 trials per task for nondeterminism. Measure correctness with the same rule-checker re-run \+ git-diff rubric you used for humans, plus surrounding-code preservation, wall-clock time, and cost. Report it as a new evaluation subsection with a three-way table: agent vs. unassisted human vs. DesignFix-assisted human.  
2. **Discuss DesignFix's unique contribution that "smarter" agents can't provide, grounded in that experiment's results.** Plan for the risk that the agent fixes violations *well* — position the unique value on what your user study actually evidences: deterministic rule-checker grounding, explanation–code separation as an independent verification channel (the P14 recovery case), diff-review trust calibration (P8's failure from skipping it), developer comprehension of the design rules (agents fix silently; developers learn nothing), and DesignFix's context extraction as agent-agnostic infrastructure that could feed any future agent.  
3. **Rewrite Threats to Validity to explicitly acknowledge user-study design bias** (mandate 2). It must cover: why a no-support control was chosen and what that limits (R2's top concern); the prohibition of in-IDE agentic assistants while conversational LLMs were allowed, and that agent-accustomed developers may be disadvantaged; the rule checker localized violations in *both* conditions (R1's P3-bias concern) and what residual bias remains; the ambiguous tutorial/ordering asymmetry; **how the user-study tasks were selected and whether DesignFix output quality influenced selection** (R2 asked this directly and the rebuttal was silent — silence twice is dangerous); single-rater first-author labeling with no inter-rater reliability; reuse of the 3 development violations in the 45-violation set; and srcML's purely-syntactic limitation.  
4. **Add the "DesignFix in the era of autonomous in-IDE agents" discussion** (mandate 3\) — how agents like Claude Code impact the work's relevance, and exactly how DesignFix differentiates itself, remains future-proof, or provides unique value. This overlaps with item 2 and can be one coherent discussion section.

### **B. Every rebuttal promise must verifiably appear in the paper (metareview's blanket clause)**

The metareview says "in addition to incorporating the clarifications and answers outlined in the rebuttal" — reviewers will grep for these. Roughly 15 items:

5. **Section VI-A conditions, stated explicitly and repeated wherever results are interpreted:** control participants used VSCode; conversational LLMs (ChatGPT, Claude.ai, Gemini) were allowed; in-IDE agentic assistants (Copilot, Cursor, Claude Code) were prohibited; all participants received identical introductions (design rules, CrowdCode, ActiveDoc checker, DesignFix workflow); no condition received fix-revealing information. Also rewrite the ambiguous sentence "For participants assigned to complete the DesignFix condition second, the tutorial also covered the LLM-assisted features" that R2 flagged as contradicting equal treatment.  
6. **Reframe Table I and Section V-C:** the Baseline prompt (rule description \+ violating snippet, 62–64%) is a foundation-model/ChatGPT-like baseline, and the 26–28-point Baseline→Final gap is the measured contribution of DesignFix's context engineering. Also justify in-paper why the no-support control was chosen for the user study (R2's explicit demand).  
7. **Add the localization-vs-repair argument:** the checker localized the defect in both conditions, but repair still required finding pattern examples, understanding the rule, and constructing a convention-consistent patch — include the P9 comparison (20 min lost unassisted vs. 13 min with DesignFix), and answer R2's question about what the study shows beyond a traditional detection tool.  
8. **Document metric judging in Section V-A** (all three reviewers asked): both metrics manually labeled by the first author against fixed rubrics; state the criteria in the paper (explanation pass \= rule matches \+ cause correctly attributed \+ consistent with suggested code; surrounding-code pass \= checker re-run passes \+ git diff confined to violation locus with no renames/comments/removed imports).  
9. **Add the EMSE 2023 prevalence evidence** to the motivation (Mehrpour & LaToza: 1,323 defects, 493 PRs, 33 languages, up to 25% of code-review defects detectable via AST-pattern design rules) — this citation is currently absent from the paper entirely.  
10. **Document rule representation and provenance in Section IV-A:** XPath queries over srcML ASTs stored as JSON, loaded by the IDE plugin at startup; rule formalism from prior work \[VL/HCC 2019\]; CrowdCode rules used verbatim (not a contribution).  
11. **Fix the dataset description (Section V-A):** clarify "Android Architectural Rules" is a rule set, not a codebase — and resolve the contradiction by naming the host code the Android violations were embedded in; explain the 45 violations were created by editing project source to introduce realistic mistakes, and where they reside (R1's explicit rebuttal question).  
12. **Add the srcML limitation** (purely syntactic, no call-graph constraints) and the **inter-rater reliability limitation** to threats — both promised, neither currently in the paper.  
13. **Sharpen the novelty framing (Intro \+ Discussion)** per your rebuttal's own argument: foreground the three empirical contributions (navigation-not-generation dominates repair difficulty, 7.2 vs 1.8 min; same-codebase examples add 8–13 points; explanation–code separation enables error detection/recovery), present trust calibration as a system-level contribution, and visibly separate the research contribution from tool engineering (R3's "reads like a tool demo" — echoed by the metareview's "novelty and distinct contribution" language).  
14. **Add the generalizability argument** (non-overlapping rule types across the two codebases; nothing codebase-specific; any Java codebase with XPath-expressible rules).

### **C. Fix the artifact end-to-end (independent rejection risk)**

15. R1 listed "material about the experiments cannot be checked" as a **reason to not accept** and couldn't find the supplemental material at all; R3's artifact check was "Partially Satisfactory" with no DOI. So: archive the package at Zenodo/Figshare with a **resolvable DOI in the Data Availability Statement**; convert the unopenable Study Insturctions.gslides to PDF; include both labeling rubrics; release the LLM outputs \+ labels for independent audit (you promised this); add the agentic-baseline logs; and verify every file opens from a clean machine.

### **D. R1's remaining reasons-to-not-accept (cheap, but required to flip a weak reject)**

16. **Show one real design rule end-to-end** — its natural-language description paired with its actual XPath query (R1's \#1 reason to reject; the paper never shows a rule's encoding).  
17. **Describe CrowdCode properly** with a citation/link, and explain how the violation dataset connects to it.  
18. **Reformulate RQ1** — it's too broad, and R1 says Section V doesn't answer it as posed; the rebuttal ignored this entirely. Narrow it to what you actually studied, e.g., "How do prompt content and structure (context elements, output constraints, one- vs. two-step generation) affect LLM performance in explaining and repairing design rule violations?"  
19. **Verify the template.** R1 says you used IEEE when the venue requires ACM. Check the venue's requirements now — if R1 is right, this is a desk-level compliance issue; if wrong, say so in the response letter.

---

## **🟡 Strongly recommended**

1. **Extend the agentic baseline to all 45 Evaluation I violations** (automatic code-fix metric only). This is literally R3's Question 1 ("how would Claude Code perform given the codebase?"), costs little once the harness exists, and gives the unique-contribution discussion quantitative teeth. Highest-leverage non-mandated item for flipping R3.  
2. **Add a second agent** (e.g., Copilot agent mode or Cursor) for at least the user-study tasks, so the "smarter agents" discussion doesn't hinge on one vendor.  
3. **Model-generalization probe:** rerun Baseline, Prompt 2, and Final with one non-OpenAI model on the 45 violations, automatic metric only. Directly removes R3's "only tested with GPT-4o" objection — which your own threats section currently concedes.  
4. **Sampled second-rater reliability:** have a second person label \~20% of the explanation/surrounding-code judgments and report Cohen's κ. Turns the admitted IRR weakness into a strength.  
5. **Screen-recording re-analysis** for R2's core objection: quantify where unassisted time actually went — distinguishing time locating the checker-reported violation (available in both conditions) from time hunting for rule-following patterns and constructing the patch. This substantiates that the navigation benefit is not a localization-information artifact.  
6. **Batch-fix R1's remaining detailed comments** (leaving any unaddressed twice signals carelessness): reference Listings 1–3 in prose; name each listing's framework at first mention (Listing 1 \= Android ViewModel/LiveData, Listing 2 \= App Engine/Objectify); explain how the rule-satisfying example is *selected* (R1's unanswered question — "anything that is not violated follows a rule"); justify sending both the full file and a separate surrounding-context section instead of one marked-up file; **redraw Figure 1** ("barely readable even with 200% zoom").  
7. **Gaps the completeness critic caught:** name the IDE/editor used *in the DesignFix condition* (the paper describes "clicking Accept in the browser and switching to the IDE" without naming either); report whether control participants **actually used** the permitted conversational LLMs (your qualitative narrative shows P1 web-searching, never LLM use — a re-reviewing R2 will notice the tension); and cite the published Android best practices the 7 Android rules were derived from, and who encoded them.  
8. **R2's minor items:** state why 0.5 was the lowest reasoning temperature tested (conspicuous since your structuring step already uses 0.2 — a justification sentence suffices); and in the Introduction, name the comparison for the "50% improvement in correctness" claim and clarify it's 50 *percentage points* (42.9% → 92.9%).  
9. **Add design-rule adoption evidence** beyond EMSE 2023 (a related-work paragraph on architecture-conformance checking, ArchUnit/linter adoption) — R3 asked "how often do developers use design rules?" and the detectability statistic doesn't answer that.  
10. **Write an exhaustive change-map cover letter** mapping every reviewer comment to the exact section/page of the change. R1 and R3 both had rebuttal questions silently ignored — this is cheap insurance nothing reads as dodged twice.

---

## **⚪ Explicitly *not* needed (don't spend time here)**

* **A new human-participant study arm with a general LLM tool** — the metareview deliberately superseded this with the simulated agentic baseline "without human participants."  
* **A full third codebase for Evaluation I** — not echoed by the metareview; the generalizability argument \+ model probe \+ agentic baseline cover the residual risk. Only if time remains.  
* Sub-0.5 temperature *runs* (a sentence suffices), full re-labeling of all 9,450 outputs (sampled κ suffices), and an original repository-mining prevalence study (EMSE 2023 \+ citations suffice).

