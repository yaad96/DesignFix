import React, { useState, useEffect } from "react";

// The OpenAI key is provided via OPENAI_API_KEY in the gitignored
// DesignFix-client/.env and injected server-side by the dev proxy (see
// src/setupProxy.js). This component never handles the key; it only reports
// whether the key is configured, using the /openai-key-status endpoint.
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
                <span style={styles.missing}>
                    Add OPENAI_API_KEY to{" "}
                    <span style={styles.code}>DesignFix-client/.env</span>
                </span>
            )}
        </div>
    );
};

export default ConfigComponent;
