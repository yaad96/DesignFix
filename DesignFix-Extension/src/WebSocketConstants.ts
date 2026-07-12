export class WebSocketConstants {
    static readonly MESSAGE_KEY_COMMAND: string = "command";
    static readonly MESSAGE_KEY_DATA: string = "data";
    
    static readonly RECEIVE_EDIT_FIX:string = "SEND_INFO_FOR_EDIT_FIX";
    static readonly SEND_CONTENT_FOR_EDIT_FIX:string = "RECEIVE_CONTENT_FOR_EDIT_FIX";
    static readonly RECEIVE_LLM_MODIFIED_FILE_CONTENT:string = "LLM_MODIFIED_FILE_CONTENT";
    static readonly RECEIVE_LLM_MODIFIED_FILE_CONTENT_backup:string = "LLM_MODIFIED_FILE_CONTENT_backup";
    
    static readonly RECEIVE_CONVERTED_JAVA_SNIPPET_MSG:string = "CONVERTED_JAVA_SNIPPET";
    static readonly RECEIVE_LLM_SNIPPET_MSG:string= "LLM_SNIPPET";
    static readonly RECEIVE_MODIFIED_RULE_MSG: string = "MODIFIED_RULE";
    static readonly RECEIVE_MODIFIED_TAG_MSG: string = "MODIFIED_TAG";
    static readonly RECEIVE_SNIPPET_XML_MSG: string = "XML_RESULT";
    static readonly RECEIVE_CODE_TO_XML_MSG: string = "EXPR_STMT";
    static readonly RECEIVE_NEW_RULE_MSG: string = "NEW_RULE";
    static readonly RECEIVE_NEW_TAG_MSG: string = "NEW_TAG";

    static readonly RECEIVE_OPEN_FILE_MSG: string = "OPEN_FILE";

    static readonly RECEIVE_REFRESH_LEARN_DESIGN_RULES_DIRECTORY_MSG: string = "REFRESH_LEARNING_DR_DIRECTORY";
    static readonly RECEIVE_LEARN_DESIGN_RULES_DATABASES_MSG: string = "LEARN_DESIGN_RULES_DATABASE";
    static readonly RECEIVE_LEARN_DESIGN_RULES_DATABASES_APPEND_MSG: string = "LEARN_DESIGN_RULES_DATABASE_APPEND";
    static readonly RECEIVE_LEARN_DESIGN_RULES_FEATURES_MSG: string = "LEARN_DESIGN_RULES_FEATURES";
    static readonly RECEIVE_LEARN_DESIGN_RULES_FEATURES_APPEND_MSG: string = "LEARN_DESIGN_RULES_FEATURES_APPEND";
    static readonly LEARN_DESIGN_RULES_HELPER_FILES_MSG: string = "LEARN_DESIGN_RULES_HELPER_FILES";
    static readonly LEARN_DESIGN_RULES_HELPER_FILES_APPEND_MSG: string = "LEARN_DESIGN_RULES_HELPER_FILES_APPEND";
    static readonly RECEIVE_MINE_DESIGN_RULES_MSG: string = "MINE_DESIGN_RULES";

    static readonly SEND_XML_FILES_MSG: string = "XML";
    static readonly SEND_RULE_TABLE_MSG: string = "RULE_TABLE";
    static readonly SEND_TAG_TABLE_MSG: string = "TAG_TABLE";
    static readonly SEND_PROJECT_HIERARCHY_MSG: string = "PROJECT_HIERARCHY";
    static readonly SEND_PROJECT_PATH_MSG: string = "PROJECT_PATH";
    static readonly SEND_VERIFY_RULES_MSG: string = "VERIFY_RULES";
    static readonly SEND_UPDATE_XML_FILE_MSG: string = "UPDATE_XML";
    static readonly SEND_CHECK_RULES_FOR_FILE_MSG: string = "CHECK_RULES_FOR_FILE";
    static readonly SEND_UPDATE_TAG_MSG: string = "UPDATE_TAG";
    static readonly SEND_FAILED_UPDATE_TAG_MSG: string = "FAILED_UPDATE_TAG";
    static readonly SEND_UPDATE_RULE_MSG: string = "UPDATE_RULE";
    static readonly SEND_FAILED_UPDATE_RULE_MSG: string = "FAILED_UPDATE_RULE";
    static readonly SEND_XML_FROM_CODE_MSG: string = "EXPR_STMT_XML";
    static readonly SEND_NEW_RULE_MSG: string = "NEW_RULE";
    static readonly SEND_FAILED_NEW_RULE_MSG: string = "FAILED_NEW_RULE";
    static readonly SEND_NEW_TAG_MSG: string = "NEW_TAG";
    static readonly SEND_FAILED_NEW_TAG_MSG: string = "FAILED_NEW_TAG";
    static readonly SEND_FILE_CHANGE_IN_IDE_MSG: string = "FILE_CHANGE";

    static readonly SEND_ELEMENT_INFO_FOR_MINE_RULES: string = "ELEMENT_INFO_FOR_MINE_RULES";
    static readonly SEND_DOI_INFORMATION: string = "DOI_INFORMATION";
    static readonly SEND_REQUEST_MINE_RULES_FOR_ELEMENT: string = "MINE_RULES_FOR_ELEMENT";
    static readonly SEND_MINED_DESIGN_RULES: string = "MINED_DESIGN_RULES";

    static readonly SEND_FEATURE_SELECTION_MSG: string = "FEATURE_SELECTION";

    static readonly SEND_ENTER_CHAT_MSG: string = "ENTER";
    static readonly SEND_LEFT_CHAT_MSG: string = "LEFT";
}
