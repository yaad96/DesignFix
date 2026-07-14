import {
    canonicalSnapshotFilePath,
    normalizeSnapshotFilePath,
    SnapshotAccumulator
} from "./snapshotAccumulator";

describe("SnapshotAccumulator", () => {
    it("deduplicates Windows path variants and emits deterministic path order", () => {
        const stage = new SnapshotAccumulator();
        stage.upsertXml({filePath: "C:\\Project\\z.java", xml: "old"});
        stage.upsertXml({filePath: "c:/project/Z.java", xml: "new"});
        stage.upsertXml({filePath: "C:\\Project\\a.java", xml: "a"});

        expect(stage.snapshot().xmlFiles).toEqual([
            {filePath: "C:/Project/a.java", xml: "a"},
            {filePath: "c:/project/Z.java", xml: "new"}
        ]);
    });

    it("resets XML, rules, and tags as one generation", () => {
        const stage = new SnapshotAccumulator();
        stage.upsertXml({filePath: "/project/A.java", xml: "xml"});
        stage.setRuleTable([{index: 1}]);
        stage.setTagTable([{tagName: "architecture"}]);

        stage.reset();

        expect(stage.snapshot()).toEqual({xmlFiles: [], ruleTable: [], tagTable: []});
    });

    it("normalizes separators without case-folding POSIX paths", () => {
        expect(normalizeSnapshotFilePath(" C:\\Project\\A.java ")).toBe("C:/Project/A.java");
        expect(canonicalSnapshotFilePath("C:/Project/A.java")).toBe("c:/project/a.java");
        expect(canonicalSnapshotFilePath("/Project/A.java")).toBe("/Project/A.java");
    });
});
