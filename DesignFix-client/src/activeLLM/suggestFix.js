import OpenAI from "openai";

// Models used for the two-step fix pipeline. Step A produces a prose analysis,
// step B structures it into JSON edits. Change these in one place; token usage,
// cost, and the logged `model` all derive from them (nothing is hardcoded).
const FIX_MODEL_A = "gpt-4o";
const FIX_MODEL_B = FIX_MODEL_A;

// Per-model list prices in USD per 1M tokens { input, output }. Used to estimate
// cost from reported token usage. Unknown models fall back to gpt-4o pricing.
const MODEL_PRICING = {
    "gpt-4o": { input: 2.5, output: 10 },
    "gpt-5.2": { input: 1.25, output: 10 },
};

// Estimate USD cost of a single call from its usage object and model name.
function estimateCallCost(model, usage) {
    const price = MODEL_PRICING[model] || MODEL_PRICING["gpt-4o"];
    const inTok = usage?.prompt_tokens || 0;
    const outTok = usage?.completion_tokens || 0;
    return (inTok / 1e6) * price.input + (outTok / 1e6) * price.output;
}

/**
 * Validates whether the returned content is likely a full file or just a partial snippet.
 * Returns an object with validation results.
 */
function validateFullFileContent(modifiedContent, originalContent) {
    const result = {
        isFullFile: true,
        warnings: [],
        confidence: 1.0
    };

    if (!modifiedContent || modifiedContent.trim().length === 0) {
        result.isFullFile = false;
        result.warnings.push("Modified content is empty");
        result.confidence = 0;
        return result;
    }

    const originalLines = originalContent.split('\n');
    const modifiedLines = modifiedContent.split('\n');
    const originalLineCount = originalLines.length;
    const modifiedLineCount = modifiedLines.length;

    // Check 1: Line count ratio - modified should be at least 70% of original
    const lineRatio = modifiedLineCount / originalLineCount;
    if (lineRatio < 0.7) {
        result.isFullFile = false;
        result.warnings.push(`Line count too low: ${modifiedLineCount} vs original ${originalLineCount} (${(lineRatio * 100).toFixed(1)}%)`);
        result.confidence -= 0.3;
    }

    // Check 2: For Java files, check for package declaration
    const originalHasPackage = /^\s*package\s+[\w.]+\s*;/m.test(originalContent);
    const modifiedHasPackage = /^\s*package\s+[\w.]+\s*;/m.test(modifiedContent);
    if (originalHasPackage && !modifiedHasPackage) {
        result.isFullFile = false;
        result.warnings.push("Missing package declaration");
        result.confidence -= 0.25;
    }

    // Check 3: Check for import statements preservation
    const originalImports = (originalContent.match(/^\s*import\s+[\w.*]+\s*;/gm) || []).length;
    const modifiedImports = (modifiedContent.match(/^\s*import\s+[\w.*]+\s*;/gm) || []).length;
    if (originalImports > 0 && modifiedImports < originalImports * 0.5) {
        result.isFullFile = false;
        result.warnings.push(`Missing imports: ${modifiedImports} vs original ${originalImports}`);
        result.confidence -= 0.25;
    }

    // Check 4: Check for class/interface declaration
    const originalHasClass = /^\s*(public\s+)?(abstract\s+)?(class|interface|enum)\s+\w+/m.test(originalContent);
    const modifiedHasClass = /^\s*(public\s+)?(abstract\s+)?(class|interface|enum)\s+\w+/m.test(modifiedContent);
    if (originalHasClass && !modifiedHasClass) {
        result.isFullFile = false;
        result.warnings.push("Missing class/interface declaration");
        result.confidence -= 0.25;
    }

    // Check 5: Character length ratio
    const charRatio = modifiedContent.length / originalContent.length;
    if (charRatio < 0.5) {
        result.isFullFile = false;
        result.warnings.push(`Character count too low: ${modifiedContent.length} vs original ${originalContent.length} (${(charRatio * 100).toFixed(1)}%)`);
        result.confidence -= 0.2;
    }

    result.confidence = Math.max(0, result.confidence);
    result.isFullFile = result.confidence >= 0.7;

    return result;
}

/**
 * Attempts to merge a code snippet into the original file content.
 * Uses context matching to find the right location for the snippet.
 */
function mergeSnippetIntoOriginal(snippet, originalContent, violationSnippet) {
    console.log("Attempting to merge snippet into original file...");

    const originalLines = originalContent.split('\n');
    const snippetLines = snippet.split('\n').filter(line => line.trim().length > 0);

    if (snippetLines.length === 0) {
        console.warn("Snippet is empty, returning original content");
        return originalContent;
    }

    // Strategy 1: Try to find the violation snippet in original and replace the matching region
    if (violationSnippet && violationSnippet.trim().length > 0) {
        const violationLines = violationSnippet.split('\n').filter(line => line.trim().length > 0);

        if (violationLines.length > 0) {
            // Find where the violation starts in the original
            const violationStart = findSnippetLocation(originalLines, violationLines);

            if (violationStart !== -1) {
                console.log(`Found violation at line ${violationStart + 1}`);

                // Find the extent of the violation in original
                const violationEnd = violationStart + violationLines.length;

                // Replace the violation region with the snippet
                const beforeViolation = originalLines.slice(0, violationStart);
                const afterViolation = originalLines.slice(violationEnd);

                const merged = [...beforeViolation, ...snippetLines, ...afterViolation].join('\n');
                console.log("Successfully merged snippet using violation location");
                return merged;
            }
        }
    }

    // Strategy 2: Try to find context lines from the snippet in the original
    // Look for the first few non-empty lines of the snippet in the original
    const contextLines = snippetLines.slice(0, Math.min(3, snippetLines.length));
    const snippetLocation = findSnippetLocation(originalLines, contextLines);

    if (snippetLocation !== -1) {
        console.log(`Found snippet context at line ${snippetLocation + 1}`);

        // Replace from this location with the snippet
        const beforeSnippet = originalLines.slice(0, snippetLocation);
        const afterSnippet = originalLines.slice(snippetLocation + snippetLines.length);

        const merged = [...beforeSnippet, ...snippetLines, ...afterSnippet].join('\n');
        console.log("Successfully merged snippet using context matching");
        return merged;
    }

    // Strategy 3: If snippet contains method signature, find and replace that method
    const methodMatch = snippet.match(/^\s*(public|private|protected)?\s*(static)?\s*[\w<>\[\]]+\s+(\w+)\s*\([^)]*\)/m);
    if (methodMatch) {
        const methodName = methodMatch[3];
        console.log(`Looking for method: ${methodName}`);

        const methodLocation = findMethodInOriginal(originalLines, methodName);
        if (methodLocation.start !== -1) {
            console.log(`Found method ${methodName} at lines ${methodLocation.start + 1}-${methodLocation.end + 1}`);

            const beforeMethod = originalLines.slice(0, methodLocation.start);
            const afterMethod = originalLines.slice(methodLocation.end + 1);

            const merged = [...beforeMethod, ...snippetLines, ...afterMethod].join('\n');
            console.log("Successfully merged snippet by replacing method");
            return merged;
        }
    }

    console.warn("Could not find suitable merge location, returning original with snippet appended as comment");
    // Last resort: return original with a warning comment
    return originalContent + "\n\n// TODO: The following fix could not be automatically merged:\n/*\n" + snippet + "\n*/";
}

/**
 * Finds the starting line index where a snippet appears in the original lines.
 * Uses fuzzy matching to handle whitespace differences.
 */
function findSnippetLocation(originalLines, snippetLines) {
    if (snippetLines.length === 0) return -1;

    const normalize = (line) => line.trim().replace(/\s+/g, ' ');
    const firstSnippetLine = normalize(snippetLines[0]);

    for (let i = 0; i < originalLines.length; i++) {
        if (normalize(originalLines[i]) === firstSnippetLine) {
            // Check if subsequent lines also match
            let allMatch = true;
            for (let j = 1; j < snippetLines.length && (i + j) < originalLines.length; j++) {
                if (normalize(originalLines[i + j]) !== normalize(snippetLines[j])) {
                    allMatch = false;
                    break;
                }
            }
            if (allMatch) {
                return i;
            }
        }
    }
    return -1;
}

/**
 * Finds a method's start and end lines in the original content.
 */
function findMethodInOriginal(originalLines, methodName) {
    const methodPattern = new RegExp(`^\\s*(public|private|protected)?\\s*(static)?\\s*[\\w<>\\[\\]]+\\s+${methodName}\\s*\\(`);

    for (let i = 0; i < originalLines.length; i++) {
        if (methodPattern.test(originalLines[i])) {
            // Found method start, now find the end by counting braces
            let braceCount = 0;
            let methodStarted = false;

            for (let j = i; j < originalLines.length; j++) {
                const line = originalLines[j];
                for (const char of line) {
                    if (char === '{') {
                        braceCount++;
                        methodStarted = true;
                    } else if (char === '}') {
                        braceCount--;
                    }
                }
                if (methodStarted && braceCount === 0) {
                    return { start: i, end: j };
                }
            }
            // If we couldn't find the end, return just the start
            return { start: i, end: i };
        }
    }
    return { start: -1, end: -1 };
}

/**
 * Ensures the modified content is a full file by validating and merging if needed.
 */
function ensureFullFileContent(modifiedContent, originalContent, violationSnippet) {
    const validation = validateFullFileContent(modifiedContent, originalContent);

    console.log("Content validation result:", {
        isFullFile: validation.isFullFile,
        confidence: validation.confidence,
        warnings: validation.warnings
    });

    if (validation.isFullFile) {
        console.log("Content validated as full file");
        return modifiedContent;
    }

    console.warn("Content appears to be partial, attempting to merge into original file");
    return mergeSnippetIntoOriginal(modifiedContent, originalContent, violationSnippet);
}

export async function suggestFix(
    rule,
    example,
    violation,
    surroundingCode,
    exampleFilePath,
    violationFilePath,
    violationFileContent,
    fixSiteFiles,
    setState,
) {
    // fixSiteFiles: optional array of { filePath, content } for OTHER files that
    // may need to change to satisfy the rule (e.g. a registry/servlet file for a
    // cross-file rule where the fix site differs from the violation site).
    const additionalFiles = Array.isArray(fixSiteFiles) ? fixSiteFiles : [];

    const additionalFilesBlock = additionalFiles.length > 0
        ? additionalFiles.map((f) => `<<<RELATED_FILE_PATH>>>
${f.filePath}
<<<END_RELATED_FILE_PATH>>>
<<<RELATED_FILE_REASON>>>
${f.reason || "related to this rule"}
<<<END_RELATED_FILE_REASON>>>

<<<RELATED_FILE_CONTENT>>>
${f.content}
<<<END_RELATED_FILE_CONTENT>>>`).join("\n\n")
        : "(none)";

    const promptA = `You are assisting with enforcing the following design rule:
${rule}

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

Produce the minimal set of file edits that makes the code satisfy the rule. Constraints:
- Prefer editing the file where the rule expects the fix to live (e.g. the registry/servlet file), which may be a related file rather than the original violation file.
- For every file you change, return its FULL rewritten content (not a diff/snippet).
- Copy every existing package declaration, import statement, comment, Javadoc, and formatting exactly as provided unless a specific line must change to satisfy the rule.
- Do NOT delete or reorder imports; append new imports after the existing block if required.
- When you modify a line, change only the minimal portion needed; leave all other lines identical.
- Preserve indentation and whitespace on all untouched lines.
- Do NOT invent files that were not provided. Only edit the original file and/or the related files listed above.

IMPORTANT: The code above has ALREADY been determined to VIOLATE this rule by a static analyzer. The violation is real. Do not conclude that no change is needed. Your job is to produce the concrete edit that makes the analyzer pass. If the fix belongs in a related file (e.g. registering a class in a central servlet), edit that file.

Before producing your response, internally check that:

- the proposed edit directly satisfies the stated design rule;
- the rule-satisfying example is used as a structural pattern, but
  example-specific class names, method names, variables, arguments,
  and types are adapted to the violating code;
- the proposed edit is the smallest change necessary;
- all unrelated declarations, imports, comments, formatting, and
  behavior remain unchanged;
- every rewritten file is complete and syntactically coherent.

Use this check to improve the answer, but do not add a separate
self-check section to the response.

Take your time and provide an unstructured response. Include: (1) a detailed explanation of your changes, and (2) for EACH file you change, its exact path followed by its fully rewritten content. Do not output JSON in this step.`;

    let attempt = 1;
    let success = false;
    console.log("=== PROMPT SENT TO chatGPT ===");
    //console.log(promptA);

    while (attempt <= 3 && !success) {
        try {
            // Read the API key from localStorage
            const apiKey = localStorage.getItem("OPENAI_API_KEY");

            // Create a new OpenAI instance with the API key from localStorage
            // Use local proxy to avoid CORS issues with direct browser-to-API calls
            const openai = new OpenAI({
                apiKey,
                baseURL: window.location.origin + "/openai-proxy/v1",
                dangerouslyAllowBrowser: true,
            });

            const chatCompletionA = await openai.chat.completions.create({
                model: FIX_MODEL_A,
                temperature: 0.50,
                messages: [{role: "user", content: promptA}],
            });

            const usageA = chatCompletionA.usage || {};
            const responseA = chatCompletionA.choices[0].message.content;

            console.log("ReceivedResponseA from chatGPT:");
            //console.log(responseA);

            // Re-supply the original file contents to the structuring step so it can
            // emit FULL modified content even when step A only described the change
            // in prose (rather than pasting the whole rewritten file). To keep this
            // second prompt small/fast, only include the files that are plausible
            // EDIT targets: the violation file plus any constraint-named fix-site
            // files. Pure example / scope files were only needed in step A and are
            // omitted here. If no fix-site files were identified, fall back to all.
            const fixSiteOnly = additionalFiles.filter((f) => /fix site/i.test(f.reason || ""));
            const structuringExtras = fixSiteOnly.length > 0 ? fixSiteOnly : additionalFiles;
            const originalFilesForStructuring = [
                `<<<FILE_PATH>>>\n${violationFilePath}\n<<<END_FILE_PATH>>>\n<<<FILE_CONTENT>>>\n${violationFileContent}\n<<<END_FILE_CONTENT>>>`,
                ...structuringExtras.map((f) => `<<<FILE_PATH>>>\n${f.filePath}\n<<<END_FILE_PATH>>>\n<<<FILE_CONTENT>>>\n${f.content}\n<<<END_FILE_CONTENT>>>`),
            ].join("\n\n");

            const promptB = `You previously analyzed a design-rule violation and described how to fix it.

Design rule:
${rule}

Your analysis / proposed fix:
${responseA}

Here are the CURRENT full contents of the candidate files you may edit:
${originalFilesForStructuring}

Now APPLY the fix you described and return ONLY JSON with this exact shape:
{"explanation":"...", "edits":[{"filePath":"...", "code":"..."}]}

The file that contains the violation is:
${violationFilePath}

Rules:
- Actually perform the edit(s): take the relevant file above and produce its FULL modified content with the change applied.
- "edits" MUST contain one entry for EVERY file whose content differs from the original above. If your analysis said a file needs a change, that file MUST appear in "edits" with its complete modified content.
- "filePath" must exactly match one of the FILE_PATH values above.
- "code" must be the ENTIRE file content after the change (not a diff, not a snippet, not a description).
- If the fix modifies a file OTHER than the file that contains the violation (shown above), you MUST state this explicitly at the start of the "explanation": clearly name which file(s) were modified and note that they differ from the file where the violation was reported, and briefly say why the fix belongs there.
- Do NOT return an empty edits array if your analysis described a change. If truly no change is needed, still return the single most-relevant file unchanged is NOT allowed — instead explain why in "explanation" and leave edits empty only if the code already fully satisfies the rule.
- Preserve all unrelated lines, imports, comments, and formatting exactly.


Return only JSON.`;

            const chatCompletionB = await openai.chat.completions.create({
                model: FIX_MODEL_B,
                temperature: 0.2,
                //max_tokens: 8000,
                response_format: {type: "json_object"},
                messages: [{role: "user", content: promptB}],
            });

            const usageB = chatCompletionB.usage || {};
            const choiceB = chatCompletionB.choices[0];
            const suggestedSnippet = choiceB.message.content;
            if (choiceB.finish_reason === "length") {
                console.error("Structured response was truncated by the token limit (finish_reason=length). Raw content:", suggestedSnippet);
                throw new Error("LLM response was truncated (output token limit). The file may be too large to rewrite in full.");
            }
            const stripped = suggestedSnippet
                .replace(/^```(?:json)?/i, "")
                .replace(/```$/i, "")
                .replace(/^`+|`+$/g, "")
                .trim();
            let parsedJSON;
            try {
                parsedJSON = JSON.parse(stripped);
            } catch (parseErr) {
                // Fallback: some models emit raw control characters (tabs/newlines)
                // inside JSON string literals. Escape stray control chars and retry.
                try {
                    const sanitized = stripped.replace(/[\u0000-\u001F]/g, (ch) => {
                        if (ch === "\n") return "\\n";
                        if (ch === "\r") return "\\r";
                        if (ch === "\t") return "\\t";
                        return "";
                    });
                    parsedJSON = JSON.parse(sanitized);
                } catch (parseErr2) {
                    console.error("Failed to parse structured JSON from chatGPT. Raw content:", suggestedSnippet);
                    throw parseErr;
                }
            }
            console.log("Parsed structured JSON:", parsedJSON);
            const explanation = parsedJSON["explanation"] ?? parsedJSON["Explanation"] ?? "";

            // Normalize into a list of edits, supporting both the new multi-file
            // shape ({edits:[{filePath, code}]}) and the legacy single-file shape
            // ({code, fileName} / {modifiedFileContent}).
            const normalizePath = (p) => (p || "").replace(/\\/g, "/");
            const violationPathNorm = normalizePath(violationFilePath);

            // The model occasionally names the file-body field differently; accept
            // any reasonable key so a good response is not discarded.
            const pickCode = (o) =>
                o?.["code"] ??
                o?.["modifiedFileContent"] ??
                o?.["content"] ??
                o?.["fileContent"] ??
                o?.["fullContent"] ??
                o?.["newContent"] ??
                o?.["fileContents"] ??
                "";
            const pickPath = (o) =>
                o?.["filePath"] ?? o?.["fileName"] ?? o?.["path"] ?? o?.["file"] ?? violationFilePath;

            const originalContentFor = (filePath) => {
                const fp = normalizePath(filePath);
                if (fp === violationPathNorm) return violationFileContent;
                const byExact = additionalFiles.find((f) => normalizePath(f.filePath) === fp);
                if (byExact) return byExact.content;
                const base = fp.split("/").pop();
                const byBase = additionalFiles.find((f) => normalizePath(f.filePath).endsWith(`/${base}`));
                if (byBase) return byBase.content;
                if (normalizePath(violationFilePath).endsWith(`/${base}`)) return violationFileContent;
                return "";
            };

            let rawEdits = [];
            const editsArray = Array.isArray(parsedJSON["edits"])
                ? parsedJSON["edits"]
                : (Array.isArray(parsedJSON["files"]) ? parsedJSON["files"] : null);
            if (editsArray && editsArray.length > 0) {
                rawEdits = editsArray.map((e) => ({
                    filePath: pickPath(e),
                    code: pickCode(e),
                }));
            } else {
                // legacy single-file fallback (top-level code/fileName)
                rawEdits = [{
                    filePath: pickPath(parsedJSON),
                    code: pickCode(parsedJSON),
                }];
            }

            const edits = rawEdits
                .filter((e) => (e.code || "").trim().length > 0)
                .map((e) => {
                    const original = originalContentFor(e.filePath);
                    return {
                        filePath: e.filePath,
                        originalFileContent: original,
                        modifiedFileContent: ensureFullFileContent(e.code, original, violation),
                    };
                });

            if (edits.length === 0) {
                console.error("No usable edits after normalization. rawEdits:", rawEdits, "parsedJSON:", parsedJSON);
                throw new Error("LLM returned no usable file edits.");
            }

            // The primary edit drives the existing single-file UI fields. Prefer the
            // edit that targets a file OTHER than the violation site when present
            // (that is usually the real fix for a cross-file rule); otherwise the
            // first edit.
            const primary = edits.find((e) => normalizePath(e.filePath) !== violationPathNorm) || edits[0];
            const fileName = primary.filePath;
            const modifiedFileContent = primary.modifiedFileContent;

            console.log("Final Solution from chatGPT received:");
            //console.log(parsedJSON);

            // sets the relevant state in the React component that made the request
            // see ../ui/rulePanel.js for more details
            setState({suggestedSnippet: modifiedFileContent});
            setState({snippetExplanation: explanation});
            setState({suggestionFileName: fileName});
            setState({suggestedEdits: edits});

            const llmModifiedFileContent = {
                command: "LLM_MODIFIED_FILE_CONTENT",
                data: {
                    filePath: `${primary.filePath}`,
                    fileToChange: `${fileName}`,
                    modifiedFileContent: modifiedFileContent,
                    explanation: explanation,
                    originalFileContent: primary.originalFileContent,
                    edits: edits,
                },
            };

            // Aggregate token usage across both LLM calls (step A prose + step B
            // structured JSON). Cost is estimated per call using each call's own
            // model pricing, so the totals stay correct even when steps A and B
            // use different models.
            const promptTokens = (usageA.prompt_tokens || 0) + (usageB.prompt_tokens || 0);
            const completionTokens = (usageA.completion_tokens || 0) + (usageB.completion_tokens || 0);
            const totalTokens = (usageA.total_tokens || 0) + (usageB.total_tokens || 0);
            const costA = estimateCallCost(FIX_MODEL_A, usageA);
            const costB = estimateCallCost(FIX_MODEL_B, usageB);
            const estimatedCostUsd = costA + costB;
            // "gpt-4o+gpt-5.2" style label when the two steps differ.
            const modelLabel = FIX_MODEL_A === FIX_MODEL_B ? FIX_MODEL_A : `${FIX_MODEL_A}+${FIX_MODEL_B}`;
            const tokenUsage = {
                model: modelLabel,
                promptTokens,
                completionTokens,
                totalTokens,
                estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
                calls: [
                    {step: "A", model: FIX_MODEL_A, estimatedCostUsd: Number(costA.toFixed(6)), ...usageA},
                    {step: "B", model: FIX_MODEL_B, estimatedCostUsd: Number(costB.toFixed(6)), ...usageB},
                ],
            };

            // Full log record for the DesignFix agentic-comparison dataset. Written
            // to disk by the extension when the user clicks "Accept Fix".
            llmModifiedFileContent.data.log = {
                createdAt: new Date().toISOString(),
                model: modelLabel,
                violationFilePath,
                exampleFilePath,
                inspectedFiles: additionalFiles.map((f) => ({
                    filePath: f.filePath,
                    reason: f.reason || "",
                })),
                editedFiles: edits.map((e) => ({
                    filePath: e.filePath,
                    originalFileContent: e.originalFileContent,
                    modifiedFileContent: e.modifiedFileContent,
                })),
                explanation,
                tokenUsage,
                prompts: {A: promptA, B: promptB},
                responses: {A: responseA, B: suggestedSnippet},
            };

            // set the modified content state, will be sent plugin
            setState({llmModifiedFileContent: llmModifiedFileContent});
            setState({fixTokenUsage: tokenUsage});

            success = true;
            return llmModifiedFileContent;
        } catch (error) {
            console.log(error);
            success = false;
            attempt++;
            // Back off before retrying, longer for rate-limit (429) errors, so we
            // don't hammer the API and make the throttling worse.
            if (attempt <= 3) {
                const isRateLimit = error && (error.status === 429 || /429|rate limit/i.test(String(error.message || "")));
                const delayMs = isRateLimit ? 5000 * attempt : 1000 * attempt;
                console.log(`Retry ${attempt}/3 in ${delayMs}ms${isRateLimit ? " (rate limited)" : ""}...`);
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }
    }
}

