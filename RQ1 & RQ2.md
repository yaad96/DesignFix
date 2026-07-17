#### RQ1: LLM Proficiency with Coding Prompts

To answer RQ1, we iteratively designed prompts to understand how different levels of guidance and context affected gpt-4o’s ability to generate correct fixes and explanations for design rule violations. We began with a baseline prompt and progressively enhanced it, observing the model’s responses at each stage. Our goal was to identify a prompt format that maximizes the model’s usefulness while revealing its limitations. All experiments in RQ1 used the same underlying model (OpenAI gpt-4o) via API, with two model versions gpt-4o-2024-08-06 (hereafter gpt-4o-aug) and gpt-4o-2024-11-20 (hereafter gpt-4o-nov) tested for completeness. Unless otherwise noted, we ran each prompt five times with each of the three different randomness settings (temperature 0.5, 0.75, 1.0) to account for variability.

Prompt Context and Baseline: The baseline prompt provided the minimal necessary context: it stated the design rule, along with the code that violates the rule. The prompt then simply asked the model to suggest a fix. For example, in one case the prompt read in essence: “Here is a design rule from the documentation. Here is code that violates it. Can you suggest a fix to make this code follow the design rule?” This baseline tests whether the model can apply a described rule to a violating code snippet with only high-level guidance.

* Prompt 1: Code-Only Fix Output. Our first refined prompt built on the baseline by explicitly instructing the model to output only the lines of code needed for the fix. We wanted the LLM to localize the change and respond with a patch-like answer, rather than verbose text. Prompt 1 appends: “Only output the lines of code needed to achieve the fix.” to the baseline prompt. This tests if gpt-4o can produce a succinct fix. In preliminary trials, we observed that while the model often did suggest the correct line(s) to change, the responses lacked explanation and sometimes omitted necessary context (e.g., imports or declarations) since we forbade additional text. This prompt stresses precision, but the limitation is that the developer gets no insight into why those lines are needed or how they relate to the design rule.

* Prompt 2: Rule-Satisfying Example from the Codebase. Prompt 2 built on Prompt 1 by adding a short code snippet from the same codebase that correctly follows the rule, presented alongside the rule description and the violating code. Prompt 1's instruction to output only the lines of code needed for the fix was retained, so the added positive example was the only change between the two variants. For example, the prompt read in essence: "Here is a design rule from the documentation, and an example from this codebase that follows it. Here is code that violates it. Only output the lines of code needed to achieve the fix." This tests whether a concrete, project-specific demonstration of the intended pattern improves the model's ability to produce a correct patch, isolating the effect of the example from the output-format instruction.

* Prompt 3: JSON with Explanation and Code, rule-following example in the input. Prompt 3 aimed to elicit both a fix and a brief explanation in a structured format. We modified the request to: “Generate a short explanation and the code needed to achieve the fix. Strictly output in JSON format with fields explanation and code.”. This format forces the model to explicitly articulate the reasoning and provide the code together. Encapsulating the response in JSON also made it easier to programmatically parse the LLM’s answer in our tool. We noted that adding the explanation increased the token usage (response length) by roughly 15%. Prompt 3 tests the model’s ability to follow a formatting constraint and to concisely justify the change. A potential limitation emerged: some model outputs, while in JSON, had minor format deviations or included extra text (the model sometimes added comments or conversational flourishes outside the JSON). This required some prompt tuning and careful parsing on our side.

* Prompt 4: Providing Additional Code Context as Input. Thus far, the model only saw a self-contained snippet (the violating code) plus a separate correct example. In Prompt 4, we augmented the prompt with relevant surrounding code from the project as input beyond the violating snippet. For instance, if the violation was in a method, we might prepend other methods or class definitions that relate to the rule. We appended to the prompt: “Here are some surrounding code snippets for more context:” followed by additional code excerpts, before asking for the fix output (similar format as Prompt 3). The idea is to emulate a more realistic scenario: in a complex codebase, the fix might depend on understanding usage in other parts of the code. By providing more context, we test the model’s capability to handle and utilize it. Prompt 4’s risk is that extra context could distract the model or exceed token limits, but we kept it focused (e.g., only including one or two related classes). This prompt particularly addresses scenarios where the violation’s fix might affect multiple components (e.g., ensuring consistency across two classes). We observed that gpt-4o could handle the context and often used it correctly (for example, referencing a class name defined in the surrounding context instead of guessing it). In this prompt evaluation, we still required JSON output with explanation and code; however, the model sometimes included surrounding context inside the code field, occasionally introducing unintended edits. This slight modification would result in an erroneous code patch altogether. We added the metric "Surrounding Code Pass Rate" after observing unintended context edits in Prompt 4 and applied it to subsequent prompts.  
    
* Prompt 5: Inline Code Context in Output. In Prompt 5, we asked the model to output not just the changed lines, but the surrounding code as well, properly formatted, along with an explanation. The motivation was that in prompt 4, we observed that the model sometimes fixed the violation while also making small, unintended edits to surrounding code. We also wanted to see if the model could integrate the fix into the broader context, ensuring the changes align with the code around them (correct syntax, proper variable usage, etc.). We specifically instructed the model to “Generate code, with the surrounding code included, to make this violation follow the rule. Do not make modifications to the surrounding unless absolutely required. Maintain proper whitespace with \\t and \\n. Don’t forget a brief explanation of your fix as well.”. This tests the model’s ability to produce a patch in situ. Including whitespace control sequences was a way to hint for preserving code formatting. We found that gpt-4o could output a code block representing the entire function or file with the fix applied. However, this made the responses longer and occasionally the model would include a large portion of the file, which might include unrelated edits or minor differences (noise). Still, Prompt 5 was valuable for assessing if the fix truly integrates well – we later manually inspected whether the suggested change, when inserted into the file, satisfies the design rule and avoids obvious issues in the surrounding context.

* “Final Prompt”: Two-Step Co-generative Approach. Beyond one-shot prompts, we experimented with a multi-turn prompting strategy, which ultimately became our final prompt design. Inspired by multi-step prompting techniques, we let the LLM first generate an unstructured draft solution and explanation, then asked it to reformat that into the structured format. In practice, this meant DesignFix would call gpt-4o twice: first with a prompt similar to Prompt 5 (surrounding context \+ ask for fix with explanation) but without enforcing JSON, and additionally instructing the model “Take as much time as you need” (to encourage a thorough answer). This often yielded a detailed narrative explanation and a code diff or patch. We captured that response (ResponseA), and then we constructed a follow-up prompt (PromptB) that essentially said: “Here is what you just did (we include the initial prompt and the model’s own answer). Now restructure this into the JSON format with explanation and code fields.”. We then fed Prompt B to gpt-4o (same model instance or a new call) to get a nicely formatted JSON answer containing the distilled explanation and code fix. This two-step approach leverages the model’s ability to reason in a free form first, and then present the result cleanly. We found this Final Prompt approach to be the most effective overall: it produced the highest correctness and explanation quality scores in our evaluation, outperforming even the single-step Prompt 5\. For example, the Explanation pass rate (a measure of correct and clear explanations; see definition in RQ2) reached 89% with gpt-4o-nov using the final two-step prompt, versus 82–84% in the best single-step prompt. The structured re-prompting increased accuracy and consistency of the output. The trade-off is slightly higher latency (two API calls instead of one), but in our use case this was acceptable (it added only a few seconds).

#### RQ2: Dataset and Codebases : For a comprehensive evaluation (RQ2), we gathered design rules and corresponding violations from two distinct codebases:

CrowdCode: An open-source microtask-programming platform used in prior research. From the 15 design rules extracted from this codebase in the prior ActiveDocumentation work (Mehrpour et al., VL/HCC 2019), we selected 8 unmodified rules covering command patterns, entity persistence, and artifact relationships (many examples mentioned in our user study come from this set). Both the rules and their seeded violations were used verbatim from the prior work's materials.

Android Architectural Rules: A purpose-built evaluation corpus (not a standalone application) comprising 7 executable rules derived from published Android best practices (for example, rules about the usage of Data Transfer Objects for serialization, or persistence patterns), together with compact Java source fixtures that exercise those rules and provide compliant examples.

For each design rule we evaluated 3 violation instances. The CrowdCode violations came pre-seeded from the prior work; we created the Android violations by editing the fixture sources to introduce realistic developer mistakes (missing annotations, incorrect method signatures, improper class relationships), yielding project versions that compile while containing the seeded violation. In total, the evaluation set comprised 45 violation examples (15 rules × 3 examples each).

LLM Configurations: We used OpenAI’s gpt-4o models for generation. Notably, gpt-4o underwent updates; we compare two versions:

gpt-4o-aug \- the august 2024 snapshot, which we used initially.

gpt-4o-nov \-  the november, 2024 update, which included improvements in following instructions and reliability.  
We ran each prompt version on both model versions to see if newer improvements yield better results. Furthermore, to account for the nondeterministic nature of the model, each prompt-version/model combination was executed with three temperature settings (0.5, 0.75, 1.0), and for each setting we generated 5 outputs (by re-invoking the model) to sample the variability. In total, each scenario had up to 15 attempts recorded. This allows us to compute metrics like success rates with some statistical significance and also evaluate pass@k (the likelihood that at least one of the top k attempts is successful).

As for RQ1, we developed prompts on a subset of violations (3 design rule violations from CrowdCode) and then fixed the final set of prompt designs for the RQ2 evaluation. For RQ2, our experiment involved 45 violations × 7 prompt types (baseline \+ Prompts 1–5 \+ Final) × 2 model versions × 3 temperatures × 5 trials \= 9450 LLM runs. This large sample enabled calculation of reliability metrics.

Evaluation Metrics:  
We assessed the model suggestions along three dimensions, inspired by prior work on code generation metrics:

1. Code Fix Success Rate: Did the AI-generated code actually resolve the design rule violation? Concretely, we applied each suggested fix to the code and checked whether our rule validation procedure no longer flags a violation (automated checker where available; otherwise manual rule-condition verification). We report this as a pass rate over multiple trials. For example, if out of 5 trials the model produced a correct fix 4 times, code-fix success \= 80%. Prompt 1’s minimal fix outputs were mainly evaluated on this metric. For our final prompt approach, we expected a high success rate here.  
2. Explanation Correctness (Explanation Pass Rate): We judged the clarity and correctness of the explanation accompanying the fix. An explanation “passes” if it correctly identifies the cause of the violation and aligns with the changes made. This was determined by manual analysis: we read the model’s explanation and checked it against the rule and code. For example, if a rule is “subclass must be annotated @Entity” and the model’s explanation says “Added @Entity to class X because subclasses of Artifact must be entities”, that is correct. If it gave a vague or wrong reason, it’s a fail. We again compute a percentage of trials that yielded a good explanation. This metric is crucial for understanding the model’s ability not just to fix, but to communicate rationale, as a good explanation can increase developer trust. Prompt 3 and beyond were evaluated on this.  
3. Integration and Completeness (Surrounding Code Pass Rate): This measures whether the fix cleanly integrates with the code around it and addresses the issue without side effects. Concretely, we manually inspected the code after applying the fix to ensure no syntax or obvious semantic errors were introduced (e.g., broken references, inconsistent variable usage), and if the rule involved multi-part fixes, we checked that the suggestion didn’t fix one part while missing another. For instance, if a rule says “do X in all relevant places”, a fix passes if it handled all occurrences, not just one. This was assessed over multiple trials similarly. Prompt 4 (where we first observed unintended edits to surrounding context in the code field) and Prompt 5 and the Final Prompt (which output surrounding code as part of the patch) were particularly evaluated here – e.g., did the model preserve unrelated code correctly when outputting a whole function.

We also recorded the Pass@k per temperature metric commonly used in code generation: the probability that at least one of the top k model outputs is correct. In our case, since we did up to 5 trials per case, we effectively looked at Pass@5 per temperature (did any of the 5 attempts fix it). For final prompts, this was usually 100% if the single-run success was high, but Pass@k is more relevant for less reliable prompts or for possibly using multiple samples to pick a best. We note it for completeness. So we decided to log and evaluate prompts based on the above-listed metrics, rather than general pass@k.

# 

# 

# 

# 

#### 

#### Evaluation of the prompts on gpt-4o

We tried all the prompts on 2 LLMs- gpt-4o-2024-08-06 and gpt-4o-2024-11-20  
   
For each LLM, we test each prompt on three temperatures: 0.5, 0.75 and 1.0

#### Explanation pass rate (%)

\\textbf{Prompt} & \\textbf{Model} & \\textbf{0.5} & \\textbf{0.75} & \\textbf{1.0} \\\\  
Prompt 3 & gpt-4o-nov & 76 & 76 & 73 \\\\  
Prompt 3 & gpt-4o-aug & 77 & 77 & 72 \\\\  
Prompt 4 & gpt-4o-nov & 75 & 74 & 70 \\\\  
Prompt 4 & gpt-4o-aug & 76 & 75 & 71 \\\\  
Prompt 5 & gpt-4o-nov & 82 & 74 & 80 \\\\  
Prompt 5 & gpt-4o-aug & 84 & 76 & 76 \\\\  
\\midrule  
Final & gpt-4o-nov & \\textbf{89} & 87 & 85 \\\\  
Final & gpt-4o-aug & 88 & 87 & 82 \\\\

#### Surrounding code pass rate (%)

\\textbf{Prompt} & \\textbf{Model} & \\textbf{0.5} & \\textbf{0.75} & \\textbf{1.0} \\\\  
Prompt 4 & gpt-4o-nov & 76 & 72 & 70 \\\\  
Prompt 4 & gpt-4o-aug & 86 & 83 & 72 \\\\  
Prompt 5 & gpt-4o-nov & 80 & 75 & 80 \\\\  
Prompt 5 & gpt-4o-aug & 78 & 81 & 79 \\\\  
\\midrule  
Final & gpt-4o-nov & \\textbf{90} & 88 & 86 \\\\  
Final & gpt-4o-aug & 89 & 85 & 85 \\\\

#### Code fix pass rate (%)

\\textbf{Prompt} & \\textbf{Model} & \\textbf{0.5} & \\textbf{0.75} & \\textbf{1.0} \\\\  
Baseline & gpt-4o-nov & 62 & 58 & 55 \\\\  
Baseline & gpt-4o-aug & 64 & 61 & 57 \\\\  
Prompt 1 & gpt-4o-nov & 68 & 65 & 62 \\\\  
Prompt 1 & gpt-4o-aug & 70 & 67 & 64 \\\\  
Prompt 2 & gpt-4o-nov & 76 & 72 & 71 \\\\  
Prompt 2 & gpt-4o-aug & 77 & 74 & 74 \\\\  
Prompt 3 & gpt-4o-nov & 76 & 73 & 72 \\\\  
Prompt 3 & gpt-4o-aug & 74 & 74 & 71 \\\\  
Prompt 4 & gpt-4o-nov & 77 & 74 & 70 \\\\  
Prompt 4 & gpt-4o-aug & 78 & 75 & 72 \\\\  
Prompt 5 & gpt-4o-nov & 80 & 78 & 72 \\\\  
Prompt 5 & gpt-4o-aug & 80 & 76 & 79 \\\\  
\\midrule  
Final & gpt-4o-nov & \\textbf{88} & 88 & 86 \\\\  
Final & gpt-4o-aug & \\textbf{90} & 89 & 87 \\\\  
