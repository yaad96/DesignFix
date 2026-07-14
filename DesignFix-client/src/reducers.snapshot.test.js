import {commitRuleSnapshot} from "./actions";
import reducer from "./reducers";
import {reduxStoreMessages} from "./reduxStoreConstants";

describe("COMMIT_RULE_SNAPSHOT", () => {
    it("publishes XML, tags, rules, and loader completion in one transition", () => {
        const previous = {
            loadingGif: true,
            xmlFiles: [{filePath: "old.java", xml: "old"}],
            tagTable: [{tagName: "old"}],
            ruleTable: [{index: "old"}],
            message: "old"
        };
        const xmlFiles = [{filePath: "A.java", xml: "new"}];
        const tagTable = [{tagName: "new"}];

        const next = reducer(previous, commitRuleSnapshot(xmlFiles, tagTable, []));

        expect(next).toEqual(expect.objectContaining({
            loadingGif: false,
            xmlFiles,
            tagTable,
            ruleTable: [],
            message: reduxStoreMessages.update_rule_table_msg
        }));
    });

    it("commits an empty snapshot instead of retaining stale project state", () => {
        const previous = {
            loadingGif: true,
            xmlFiles: [{filePath: "old.java", xml: "old"}],
            tagTable: [{tagName: "old"}],
            ruleTable: [],
            message: "old"
        };

        const next = reducer(previous, commitRuleSnapshot([], [], []));

        expect(next.loadingGif).toBe(false);
        expect(next.xmlFiles).toEqual([]);
        expect(next.tagTable).toEqual([]);
        expect(next.ruleTable).toEqual([]);
    });
});
