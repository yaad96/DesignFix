import {
    EDIT_PROTOCOL_VERSION,
    EditProtocolError,
    buildCandidateManifest,
    materializeEdits,
    parseAndMaterializeResponse,
} from "./editProtocol";

const manifestFor = (files) => buildCandidateManifest(files);

const modify = (candidate, replacements, overrides = {}) => ({
    filePath: candidate.filePath,
    operation: "modify",
    baseHash: candidate.baseHash,
    replacements,
    ...overrides,
});

const replacement = (oldText, newText) => ({
    oldText,
    newText,
    expectedOccurrences: 1,
});

const expectProtocolError = (fn, code) => {
    try {
        fn();
        throw new Error(`Expected ${code}`);
    } catch (error) {
        expect(error).toBeInstanceOf(EditProtocolError);
        expect(error.code).toBe(code);
    }
};

describe("DesignFix anchored edit protocol", () => {
    test("materializes a small replacement locally and preserves CRLF", () => {
        const [candidate] = manifestFor([{
            filePath: "F:/project/Project.java",
            content: "class Project {\r\n\tvoid save() {\r\n\t\tofy().save().entity(this);\r\n\t}\r\n}\r\n",
        }]);

        const [edit] = materializeEdits([
            modify(candidate, [replacement(
                "\t\tofy().save().entity(this);",
                "\t\tofy().save().entity(this).now();",
            )]),
        ], [candidate]);

        expect(edit.modifiedFileContent).toContain("entity(this).now();\r\n");
        expect(edit.modifiedFileContent).not.toMatch(/(?<!\r)\n/);
        expect(edit.originalFileContent).toBe(candidate.content);
    });

    test("rejects an unknown path and discards the entire multi-file batch", () => {
        const candidates = manifestFor([
            {filePath: "F:/project/Project.java", content: "class Project { Object mapper; }\n"},
            {filePath: "F:/project/DTO.java", content: "class DTO {}\n"},
        ]);
        const project = candidates[0];

        const edits = [
            modify(project, [replacement(" Object mapper;", "")]),
            {
                filePath: "F:/project/ProjectDTO.java",
                operation: "create",
                baseHash: "00000000",
                code: "class ProjectDTO {}\n",
            },
        ];

        expectProtocolError(() => materializeEdits(edits, candidates), "UNKNOWN_FILE_PATH");
        expect(project.content).toBe("class Project { Object mapper; }\n");
    });

    test("rejects Rule 7-style abbreviation placeholders", () => {
        const candidates = manifestFor([
            {
                filePath: "F:/project/Function.java",
                content: "class Function {\n    void seed() { new Test(); }\n}\n",
            },
            {
                filePath: "F:/project/FunctionCommand.java",
                content: "class FunctionCommand {\n    void existing() {}\n}\n",
            },
        ]);

        expectProtocolError(() => materializeEdits([
            modify(candidates[0], [replacement(
                "    void seed() { new Test(); }",
                "    void seed() { FunctionCommand.createHelperArtifacts(); }",
            )]),
            modify(candidates[1], [replacement(
                "    void existing() {}",
                "    // Existing methods...\n    static void createHelperArtifacts() {}",
            )]),
        ], candidates), "INCOMPLETE_EDIT");
        expect(candidates[0].content).toContain("new Test()");
        expect(candidates[1].content).not.toContain("createHelperArtifacts");
    });

    test("rejects Rule 10-style pseudo-file insertion", () => {
        const [candidate] = manifestFor([{
            filePath: "F:/project/Project.java",
            content: "package demo;\npublic class Project {\n    Project() { ofy().save().entity(this); }\n}\n",
        }]);
        const partialFile = "package demo;\npublic class Project {\n    Project() {\n        of...";

        expectProtocolError(() => materializeEdits([
            modify(candidate, [replacement(
                "    Project() { ofy().save().entity(this); }",
                partialFile,
            )]),
        ], [candidate]), "INCOMPLETE_EDIT");
    });

    test("rejects missing and ambiguous anchors", () => {
        const [candidate] = manifestFor([{
            filePath: "F:/project/Test.java",
            content: "class Test {\n    int value;\n    int value;\n}\n",
        }]);

        expectProtocolError(() => materializeEdits([
            modify(candidate, [replacement("    int missing;", "    long missing;")]),
        ], [candidate]), "ANCHOR_NOT_FOUND");

        expectProtocolError(() => materializeEdits([
            modify(candidate, [replacement("    int value;", "    long value;")]),
        ], [candidate]), "AMBIGUOUS_ANCHOR");
    });

    test("rejects overlapping replacements", () => {
        const [candidate] = manifestFor([{
            filePath: "F:/project/Test.java",
            content: "class Test { int value; }\n",
        }]);

        expectProtocolError(() => materializeEdits([
            modify(candidate, [
                replacement("int value", "long value"),
                replacement("value;", "other;"),
            ]),
        ], [candidate]), "OVERLAPPING_REPLACEMENTS");
    });

    test("rejects whole-file anchors on nontrivial files", () => {
        const content = Array.from({length: 100}, (_, i) => `// line ${i}`).join("\n") + "\n";
        const [candidate] = manifestFor([{filePath: "F:/project/Large.java", content}]);

        expectProtocolError(() => materializeEdits([
            modify(candidate, [replacement(content, content.replace("// line 50", "// changed"))]),
        ], [candidate]), "FULL_FILE_REWRITE");
    });

    test("requires the exact base hash", () => {
        const [candidate] = manifestFor([{
            filePath: "F:/project/Test.java",
            content: "class Test {}\n",
        }]);

        expectProtocolError(() => materializeEdits([
            modify(candidate, [replacement("Test", "Renamed")], {baseHash: "deadbeef"}),
        ], [candidate]), "STALE_BASE");
    });

    test("supports explicitly allowlisted file creation only", () => {
        const [candidate] = manifestFor([{
            filePath: "F:/project/NewDTO.java",
            content: "",
            allowCreate: true,
        }]);

        const response = parseAndMaterializeResponse({
            schemaVersion: EDIT_PROTOCOL_VERSION,
            explanation: "Create the explicitly requested DTO.",
            edits: [{
                filePath: candidate.filePath,
                operation: "create",
                baseHash: candidate.baseHash,
                code: "package demo;\npublic class NewDTO {}\n",
            }],
        }, [candidate]);

        expect(response.edits[0].modifiedFileContent).toContain("class NewDTO");
    });

    test("materializes a valid two-file proposal only after both files validate", () => {
        const candidates = manifestFor([
            {filePath: "F:/project/A.java", content: "class A { int a; }\n"},
            {filePath: "F:/project/B.java", content: "class B { int b; }\n"},
        ]);

        const result = materializeEdits([
            modify(candidates[0], [replacement("int a", "long a")]),
            modify(candidates[1], [replacement("int b", "long b")]),
        ], candidates);

        expect(result).toHaveLength(2);
        expect(result[0].modifiedFileContent).toContain("long a");
        expect(result[1].modifiedFileContent).toContain("long b");
    });
});
