import {checkRulesForAll} from "./ruleExecutor";

const xmlFiles = [
    {filePath: "C:/project/A.java", xml: "<unit/>"},
    {filePath: "C:/project/B.java", xml: "<unit/>"}
];

const rule = (overrides = {}) => ({
    index: 1,
    title: "Rule",
    description: "Description",
    tags: [],
    grammar: "",
    checkForFilesFolders: [],
    checkForFilesFoldersConstraints: "NONE",
    processFilesFolders: "BETWEEN",
    quantifierXPathQuery: ["//definitely_missing"],
    constraintXPathQuery: ["//definitely_missing"],
    ...overrides
});

describe("full rule evaluation", () => {
    it("replaces BETWEEN results instead of accumulating duplicate generations", () => {
        const rules = [rule()];

        checkRulesForAll(xmlFiles, rules);
        checkRulesForAll(xmlFiles, rules);

        expect(rules[0].xPathQueryResult.map(result => result.filePath)).toEqual([
            "C:/project/A.java",
            "C:/project/B.java"
        ]);
    });

    it("replaces MIXED results instead of accumulating duplicate generations", () => {
        const rules = [rule({processFilesFolders: "MIXED"})];

        checkRulesForAll(xmlFiles, rules);
        checkRulesForAll(xmlFiles, rules);

        expect(rules[0].xPathQueryResult.map(result => result.filePath)).toEqual([
            "C:/project/A.java",
            "C:/project/B.java"
        ]);
    });

    it("starts EXCLUDE filtering from all XML files and clears deleted paths", () => {
        const rules = [rule({
            checkForFilesFolders: ["B.java"],
            checkForFilesFoldersConstraints: "EXCLUDE",
            processFilesFolders: "WITHIN"
        })];

        checkRulesForAll(xmlFiles, rules);
        expect(rules[0].xPathQueryResult.map(result => result.filePath)).toEqual(["C:/project/A.java"]);

        checkRulesForAll([], rules);
        expect(rules[0].xPathQueryResult).toEqual([]);
    });
});
