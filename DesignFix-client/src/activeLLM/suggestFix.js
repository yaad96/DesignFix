import OpenAI from "openai";
import {
    EDIT_PROTOCOL_VERSION,
    buildCandidateManifest,
    normalizeFilePath,
    parseAndMaterializeResponse,
} from "./editProtocol";
import {
    buildEditStructuringPrompt,
    buildFixAnalysisPrompt,
} from "./fixPrompts";

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

export async function suggestFix(
    rule,
    constraintXPath,
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
    const candidateFiles = buildCandidateManifest([
        {filePath: violationFilePath, content: violationFileContent},
        ...additionalFiles.map((file) => ({
            filePath: file.filePath,
            content: file.content,
            // File creation is never inferred from an unknown path. A caller
            // must explicitly pre-authorize a concrete empty candidate.
            allowCreate: file.allowCreate === true,
        })),
    ]);

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

    const promptA = buildFixAnalysisPrompt({
        rule,
        constraintXPath,
        example,
        violation,
        surroundingCode,
        exampleFilePath,
        violationFilePath,
        violationFileContent,
        additionalFilesBlock,
    });

    let attempt = 1;
    let success = false;
    console.log("=== PROMPT SENT TO chatGPT ===");
    //console.log(promptA);

    while (attempt <= 3 && !success) {
        try {
            // The real OpenAI key is injected server-side by the dev proxy
            // (src/setupProxy.js) from OPENAI_API_KEY in the gitignored
            // DesignFix-client/.env, so the browser never holds it. This
            // placeholder only satisfies the SDK, which rejects an empty apiKey;
            // the proxy overwrites the Authorization header on the way out.
            const openai = new OpenAI({
                apiKey: "managed-by-designfix-proxy",
                baseURL: window.location.origin + "/openai-proxy/v1",
                dangerouslyAllowBrowser: true,
            });

            const chatCompletionA = await openai.chat.completions.create({
                model: FIX_MODEL_A,
                temperature: 0.5,
                //max_tokens: 1800,
                messages: [{role: "user", content: promptA}],
            });

            const usageA = chatCompletionA.usage || {};
            if (chatCompletionA.choices[0].finish_reason === "length") {
                throw new Error("The fix analysis exceeded its output budget. Narrow the candidate files and retry.");
            }
            const responseA = chatCompletionA.choices[0].message.content;

            console.log("ReceivedResponseA from chatGPT:");
            //console.log(responseA);

            // The same exact manifest now drives both the prompt and validation.
            // This prevents Call B from losing a required cross-file target and
            // prevents its parser from accepting a path the model never received.
            const originalFilesForStructuring = candidateFiles.map((file) => `<<<FILE_PATH>>>
${file.filePath}
<<<END_FILE_PATH>>>
<<<BASE_HASH>>>
${file.baseHash}
<<<END_BASE_HASH>>>
<<<ALLOW_CREATE>>>
${file.allowCreate ? "true" : "false"}
<<<END_ALLOW_CREATE>>>
<<<FILE_CONTENT>>>
${file.content}
<<<END_FILE_CONTENT>>>`).join("\n\n");

            const promptB = buildEditStructuringPrompt({
                rule,
                constraintXPath,
                responseA,
                originalFilesForStructuring,
                violationFilePath,
                editProtocolVersion: EDIT_PROTOCOL_VERSION,
            });

            const chatCompletionB = await openai.chat.completions.create({
                model: FIX_MODEL_B,
                temperature: 0,
                //max_tokens: 4000,
                response_format: {type: "json_object"},
                messages: [{role: "user", content: promptB}],
            });

            const usageB = chatCompletionB.usage || {};
            const choiceB = chatCompletionB.choices[0];
            const suggestedSnippet = choiceB.message.content;
            if (choiceB.finish_reason === "length") {
                console.error("Structured response was truncated by the token limit (finish_reason=length). Raw content:", suggestedSnippet);
                throw new Error("LLM edit response was truncated. No edit was applied.");
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
            const materialized = parseAndMaterializeResponse(parsedJSON, candidateFiles);
            const explanation = materialized.explanation;
            const edits = materialized.edits;
            const violationPathNorm = normalizeFilePath(violationFilePath);

            // The primary edit drives the existing single-file UI fields. Prefer the
            // edit that targets a file OTHER than the violation site when present
            // (that is usually the real fix for a cross-file rule); otherwise the
            // first edit.
            const primary = edits.find((e) => normalizeFilePath(e.filePath) !== violationPathNorm) || edits[0];
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
                    schemaVersion: EDIT_PROTOCOL_VERSION,
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

            // Full log record for the DesignFix agentic-comparison dataset. Sent
            // to the extension when the user clicks "Accept Fix" below, but held
            // in memory there and only written to data/ once the user accepts the
            // diff review inside VS Code. A rejected review leaves no run folder.
            llmModifiedFileContent.data.log = {
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
                    operation: e.operation,
                    baseHash: e.baseHash,
                    replacements: e.replacements,
                })),
                explanation,
                schemaVersion: EDIT_PROTOCOL_VERSION,
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

