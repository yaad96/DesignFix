import { WebSocketConstants } from "./WebSocketConstants";

interface EncodeDataParams {
    command: string;
    data: string | object; // Updated to accept both strings and objects
}

interface EncodeXMLDataParams {
    command: string;
    data: {
        filePath: string;
        xml: string;
    };
}

export class MessageProcessor {
    // Existing method for encoding simple messages
    static encodeData({ command, data }: EncodeDataParams): string {
        const message = {
            [WebSocketConstants.MESSAGE_KEY_COMMAND]: command,
            [WebSocketConstants.MESSAGE_KEY_DATA]: data,
        };
        return JSON.stringify(message);
    }

    // New method for encoding XML data messages
    static encodeXMLData({ command, data }: EncodeXMLDataParams): string {
        const message = {
            [WebSocketConstants.MESSAGE_KEY_COMMAND]: command,
            [WebSocketConstants.MESSAGE_KEY_DATA]: data, // No change needed here as JSON.stringify will handle it correctly
        };
        return JSON.stringify(message);
    }
}
