import {
    buildEditStructuringPrompt,
    buildFixAnalysisPrompt,
    normalizeConstraintXPath,
} from "./fixPrompts";

const analysisPrompt = (overrides = {}) => buildFixAnalysisPrompt({
    rule: "A natural-language design rule.",
    constraintXPath: "//authoritative/condition",
    example: "class PassingExample {}",
    violation: "class ViolatingExample {}",
    surroundingCode: "package demo;",
    exampleFilePath: "F:/project/PassingExample.java",
    violationFilePath: "F:/project/ViolatingExample.java",
    violationFileContent: "package demo;\nclass ViolatingExample {}\n",
    additionalFilesBlock: "(none)",
    ...overrides,
});

describe("DesignFix completeness-first prompts", () => {
    test("normalizes array, string, and absent analyzer constraints", () => {
        expect(normalizeConstraintXPath(["  //first  ", "", null, "//second"])).toBe("//first\n//second");
        expect(normalizeConstraintXPath("  //single  ")).toBe("//single");
        expect(normalizeConstraintXPath(undefined)).toBe("");
    });

    test("Rule 3 makes index=true authoritative despite a misleading Entity description", () => {
        const constraintXPath = "//src:class[src:super/src:extends/src:name='Artifact'][src:annotation/src:name='Subclass' and src:annotation/src:argument_list/src:argument/src:expr/src:operator='=' and src:annotation/src:argument_list/src:argument/src:expr/src:literal='true']";
        const prompt = analysisPrompt({
            rule: "All Artifact subclasses should have the @Entity annotation.",
            constraintXPath,
            example: "@Subclass(index=true)\npublic class Function extends Artifact {}",
            violation: "@Subclass(index=false)\npublic class Test extends Artifact {}",
            violationFileContent: "@Subclass(index=false)\npublic class Test extends Artifact {}\n",
        });

        expect(prompt).toContain(constraintXPath);
        expect(prompt).toContain("@Subclass(index=true)");
        expect(prompt).toContain("@Subclass(index=false)");
        expect(prompt).toContain("it defines what the analyzer accepts");
        expect(prompt).toContain("do not duplicate it");
        expect(prompt).toContain("missing arguments, values, or companion constructs");
        expect(prompt).toContain("Modify an incorrect annotation or declaration in place");
        expect(prompt).toContain("smallest complete satisfying patch, not the fewest changed tokens");
        expect(prompt).toContain("Required pattern: enumerate every rule-relevant component");
        expect(prompt).toContain("Edit plan: map every unsatisfied component");
        expect(prompt).not.toContain("describe only the smallest required replacement(s)");
    });

    test("Rule 4 treats Ref plus Parent and Load as one complete satisfying pattern", () => {
        const satisfyingField = "@Parent @Load private Ref<Artifact> artifactRef;";
        const prompt = analysisPrompt({
            rule: "A Microtask must reference its owning Artifact.",
            constraintXPath: "//src:decl[src:type//src:name='Ref' and src:annotation/src:name='Parent' and src:annotation/src:name='Load']",
            example: `public class ImplementBehavior extends Microtask {\n    ${satisfyingField}\n}`,
            violation: "private Key<Artifact> artifactKey;",
            violationFileContent: "public class Review extends Microtask {\n    private Key<Artifact> artifactKey;\n}\n",
        });

        expect(prompt).toContain(satisfyingField);
        expect(prompt).toContain("Treat companion annotations and their type as one complete satisfying pattern");
        expect(prompt).toContain("annotations, annotation arguments, modifiers, types");
        expect(prompt).toContain("Do not omit an annotation, annotation argument, modifier, type");
        expect(prompt).toContain("every component of the complete satisfying pattern is represented");
    });

    test("Call B preserves every planned requirement while keeping anchors local", () => {
        const prompt = buildEditStructuringPrompt({
            rule: "A Microtask must reference its owning Artifact.",
            constraintXPath: ["//src:decl[src:type//src:name='Ref']", "//src:decl[src:annotation/src:name='Parent']"],
            responseA: "Replace Key<Artifact> with @Parent @Load private Ref<Artifact>, then update constructor assignment and getter use.",
            originalFilesForStructuring: `<<<FILE_PATH>>>
F:/project/Review.java
<<<END_FILE_PATH>>>
<<<BASE_HASH>>>
12345678
<<<END_BASE_HASH>>>
<<<ALLOW_CREATE>>>
false
<<<END_ALLOW_CREATE>>>
<<<FILE_CONTENT>>>
class Review {}
<<<END_FILE_CONTENT>>>`,
            violationFilePath: "F:/project/Review.java",
            editProtocolVersion: 2,
        });

        expect(prompt).toContain("Now APPLY the complete fix you described");
        expect(prompt).toContain("Do not simplify the plan merely to reduce the number or size of replacements");
        expect(prompt).toContain("if the analysis omitted a required component, include it now");
        expect(prompt).toContain("Every required component must either already exist correctly in FILE_CONTENT");
        expect(prompt).toContain("map every planned annotation, annotation argument, modifier, type change");
        expect(prompt).toContain("Minimize only the span of each oldText anchor");
        expect(prompt).toContain("Use multiple non-overlapping replacements");
        expect(prompt).toContain("Apply all rule-relevant companion annotations");
        expect(prompt).toContain("a type-only or annotation-only subset is not complete");
        expect(prompt).toContain("Do not duplicate an existing annotation or declaration");
        expect(prompt).toContain('"schemaVersion":2');
    });
});
