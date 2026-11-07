# Change Log

## 0.1.0 (Preview)

- The dashboard now ships inside the extension. Open it from the **DesignFix** status bar item or with **DesignFix: Open Dashboard**; no separate Node.js setup is needed.
- The OpenAI API key is kept in VS Code secret storage (**DesignFix: Set OpenAI API Key**) and added to requests by the extension.
- Security: the dashboard server listens on 127.0.0.1 only and checks the Host and Origin of every request. The development socket (port 8887) is limited to Extension Development Hosts and to the dashboard's own page. Rule-mining file names and parameters are validated, and SPMF runs without a shell.
- The dashboard no longer loads anything from third-party servers.
- Accepted fixes are recorded only when `designfix.fixLogs.enabled` is on.
- New settings: `designfix.srcmlPath`, `designfix.dashboard.port`, `designfix.fixLogs.enabled`, `designfix.fixLogs.directory`, `designfix.devSocket.enabled`.
- Clear error messages when srcML or the Visual C++ runtime is missing.
- Third-party notices for srcML, its libraries, and the dashboard's packages.

## 0.0.3 (Preview)

- First Marketplace release.
- Converts the open Java project to srcML and streams it to the DesignFix dashboard, which checks the rules in `ruleTable.json`.
- Shows LLM-suggested fixes as a VS Code diff with **DesignFix: Accept Fix** and **DesignFix: Reject Fix**.
- The dashboard still runs separately from source; see the README.
