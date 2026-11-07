import React, { useState, useEffect } from "react";

// The OpenAI key never reaches the browser. In the installed extension it is
// kept in VS Code secret storage ("DesignFix: Set OpenAI API Key"); when the
// dashboard runs from source it comes from OPENAI_API_KEY in the gitignored
// DesignFix-client/.env (see src/setupProxy.js). Either way the server adds it
// to OpenAI requests. This component only reports whether a key is configured,
// using the /openai-key-status endpoint.
const ConfigComponent = () => {
    const [configured, setConfigured] = useState(null);

    useEffect(() => {
        let active = true;
        fetch("/openai-key-status")
            .then((res) => res.json())
            .then((data) => {
                if (active) setConfigured(!!data.configured);
            })
            .catch(() => {
                if (active) setConfigured(false);
            });
        return () => {
            active = false;
        };
    }, []);

    const styles = {
        container: { textAlign: "center", color: "white", fontSize: "14px" },
        ok: { color: "#4CAF50", fontWeight: "bold" },
        missing: { color: "#E0A800", fontWeight: "bold" },
        code: { fontFamily: "monospace" },
    };

    // Nothing to show until the status has loaded.
    if (configured === null) {
        return null;
    }

    return (
        <div style={styles.container}>
            {configured ? (
                <span style={styles.ok}>DesignFix LLM: key loaded</span>
            ) : (
                window.__DESIGNFIX_EMBEDDED__ ? (
                    <span style={styles.missing}>
                        No OpenAI key: in VS Code, run{" "}
                        <span style={styles.code}>DesignFix: Set OpenAI API Key</span>
                    </span>
                ) : (
                    <span style={styles.missing}>
                        Add OPENAI_API_KEY to{" "}
                        <span style={styles.code}>DesignFix-client/.env</span>
                    </span>
                )
            )}
        </div>
    );
};

export default ConfigComponent;
