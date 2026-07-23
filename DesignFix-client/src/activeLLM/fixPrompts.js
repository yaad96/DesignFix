export function normalizeConstraintXPath(constraintXPath) {
    if (Array.isArray(constraintXPath)) {
        return constraintXPath
            .map((query) => String(query || "").trim())
            .filter(Boolean)
            .join("\n");
    }

    return constraintXPath == null ? "" : String(constraintXPath).trim();
}

export function buildFixAnalysisPrompt({
    rule,
    constraintXPath,
    example,
    violation,
    surroundingCode,
    exampleFilePath,
    violationFilePath,
    violationFileContent,
    additionalFilesBlock = "(none)",
}) {
    const authoritativeConstraint = normalizeConstraintXPath(constraintXPath);

    return `You are assisting with enforcing the following design rule:
${rule}

The static analyzer uses the following authoritative constraint:
<<<AUTHORITATIVE_CONSTRAINT_XPATH>>>
${authoritativeConstraint || "(not provided)"}
<<<END_AUTHORITATIVE_CONSTRAINT_XPATH>>>

When an authoritative constraint is provided, it defines what the analyzer accepts. If it differs from, or is more specific than, the natural-language rule, follow the authoritative constraint and the satisfying example. Do not substitute a looser interpretation of the natural-language description.

Here is a code example that follows the rule:
${example}
Example file path: ${exampleFilePath}

<<<ORIGINAL_FILE_PATH>>>
${violationFilePath}
<<<END_ORIGINAL_FILE_PATH>>>

<<<ORIGINAL_FILE_CONTENT>>>
${violationFileContent}
<<<END_ORIGINAL_FILE_CONTENT>>>

Here is the surrounding class/method structure around the violation, showing the enclosing context:
<<<SURROUNDING_CONTEXT>>>
${surroundingCode}
<<<END_SURROUNDING_CONTEXT>>>

<<<VIOLATION_SNIPPET>>>
${violation}
<<<END_VIOLATION_SNIPPET>>>

Some design rules are satisfied by changing a DIFFERENT file than the one that contains the violation (for example, a class must be registered in a central registry/servlet file). The following related files are provided so you can make the fix in the correct place. Each is tagged with a reason; a file tagged as satisfying this rule (the correct example) shows the exact pattern the fixed code should follow. You may edit the original file, one or more of these related files, or both:
${additionalFilesBlock}

Produce a concise edit plan that makes the code satisfy the rule. Correctness and completeness take priority over patch size.

First derive the complete satisfying pattern from the authoritative constraint and the positive example. Explicitly identify every rule-relevant component that the violating code must gain or change, including annotations, annotation arguments, modifiers, types, initialization or construction logic, and dependent uses. Treat companion annotations and their type as one complete satisfying pattern even when applying that pattern requires multiple replacements.

Constraints:
- Prefer editing the file where the rule expects the fix to live (e.g. the registry/servlet file), which may be a related file rather than the original violation file.
- Name each file that must change and describe the smallest complete set of required replacements. "Minimal" means the smallest complete satisfying patch, not the fewest changed tokens.
- Apply the full satisfying pattern from the example, adapted to the violating code. Do not omit an annotation, annotation argument, modifier, type, initialization, construction step, or dependent use merely to make the diff smaller.
- Treat a component that already exists in the correct form as satisfied and leave it unchanged.
- If the target already contains the construct named by the natural-language rule, do not duplicate it. Compare the existing construct with the authoritative constraint and positive example to find missing arguments, values, or companion constructs. Modify an incorrect annotation or declaration in place; never add a duplicate with the same name or role.
- Do NOT reproduce any complete file. Do NOT use placeholders such as "existing methods" or "rest unchanged".
- Do NOT delete or reorder imports unless the rule requires it.
- If your fix references a type (class, annotation, interface, or enum) that is not already imported in the file you are editing, and that type is not declared in the same package or in java.lang, you MUST add the required import statement(s). Code that uses a type without importing it does not compile, so the fix is incomplete without it.
- Do NOT invent files that were not provided. Only edit the original file and/or the related files listed above.

IMPORTANT: The code above has ALREADY been determined to VIOLATE this rule by a static analyzer. The violation is real. Do not conclude that no change is needed. Your job is to produce the concrete edit that makes the analyzer pass. If the fix belongs in a related file (e.g. registering a class in a central servlet), edit that file.

Before producing your response, internally check that:

- every component of the complete satisfying pattern is represented in the edit plan;
- the proposed edit directly satisfies the authoritative constraint and stated design rule;
- the rule-satisfying example is used as a structural pattern, but
  example-specific class names, method names, variables, arguments,
  and types are adapted to the violating code;
- the proposed edit is the smallest complete change necessary;
- all unrelated declarations, existing imports, comments, formatting, and
  behavior remain unchanged, except that every import required by the new
  code is added;
- every proposed replacement is syntactically coherent with the surrounding code.

Use this check to improve the answer. Respond concisely using exactly two sections:
1. Required pattern: enumerate every rule-relevant component and say whether it is already satisfied or requires an edit.
2. Edit plan: map every unsatisfied component to a concrete replacement in a named file.

Do not output JSON or complete file contents in this step.`;
}

export function buildEditStructuringPrompt({
    rule,
    constraintXPath,
    responseA,
    originalFilesForStructuring,
    violationFilePath,
    editProtocolVersion,
}) {
    const authoritativeConstraint = normalizeConstraintXPath(constraintXPath);

    return `You previously analyzed a design-rule violation and described how to fix it.

Design rule:
${rule}

Authoritative static-analyzer constraint:
<<<AUTHORITATIVE_CONSTRAINT_XPATH>>>
${authoritativeConstraint || "(not provided)"}
<<<END_AUTHORITATIVE_CONSTRAINT_XPATH>>>

Your analysis / proposed fix:
${responseA}

Here are the CURRENT full contents of the candidate files you may edit:
${originalFilesForStructuring}

Now APPLY the complete fix you described and return ONLY JSON using edit schema version ${editProtocolVersion}.

For existing files, use this exact shape:
{"schemaVersion":${editProtocolVersion},"explanation":"...","edits":[{"filePath":"exact FILE_PATH","operation":"modify","baseHash":"exact BASE_HASH","replacements":[{"oldText":"exact unique text copied from FILE_CONTENT","newText":"replacement text","expectedOccurrences":1}]}]}

Only when a candidate explicitly says ALLOW_CREATE=true, a creation may use:
{"filePath":"exact FILE_PATH","operation":"create","baseHash":"exact BASE_HASH","code":"complete new-file content"}

The file that contains the violation is:
${violationFilePath}

Correctness and completeness take priority over replacement or anchor size. Preserve every rule-relevant requirement from the analysis. Do not simplify the plan merely to reduce the number or size of replacements. Independently compare the candidate code with the authoritative constraint and satisfying pattern; if the analysis omitted a required component, include it now. Every required component must either already exist correctly in FILE_CONTENT or be introduced or corrected by newText. Before responding, internally map every planned annotation, annotation argument, modifier, type change, initialization or construction change, and dependent-use change to at least one replacement, and add an import replacement for every newly referenced type that is not already imported in that file.

Rules:
- Return one edit entry for every file that must change, and no unchanged files.
- "filePath" must exactly match one of the FILE_PATH values above.
- Copy that file's BASE_HASH exactly into "baseHash".
- For a modify operation, each oldText must be copied exactly from FILE_CONTENT and must occur exactly once. Include enough surrounding syntax to make oldText unique. Minimize only the span of each oldText anchor; never omit a required replacement or required newText merely to reduce edit count or patch size.
- newText is only the replacement for oldText. Never return a complete existing file.
- Use multiple non-overlapping replacements when separate locations must change or when they are needed to implement every part of the complete satisfying pattern.
- Apply all rule-relevant companion annotations and annotation arguments required by the authoritative constraint and demonstrated by the satisfying pattern; a type-only or annotation-only subset is not complete when the pattern requires both.
- Do not duplicate an existing annotation or declaration. If its current form is incomplete or incorrect, replace it in place.
- Do not use Markdown fences, ellipses, placeholders, "existing methods", or "rest unchanged".
- Do not invent a new path. Unknown paths and implicit file creation are rejected.
- If the fix modifies a file OTHER than the file that contains the violation (shown above), you MUST state this explicitly at the start of the "explanation": clearly name which file(s) were modified and note that they differ from the file where the violation was reported, and briefly say why the fix belongs there.
- The violation is confirmed, so do not return an empty edits array.
- Preserve all unrelated existing lines, imports, comments, formatting, and behavior exactly. But if your edits reference a type that is not yet imported in that file (and it is not in the same package or in java.lang), you MUST add an extra replacement that inserts the required import statement(s), anchored on the existing import block: extend the last existing "import ...;" line, or the "package ...;" line when the file has no imports. A fix that uses a new type without its import is incomplete.

Return only JSON.`;
}
