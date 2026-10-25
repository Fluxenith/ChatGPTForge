# Connect ChatGPT to Forge

1. Create a project folder and run the init command from the README. Use a dedicated configuration directory when needed via CHATGPTFORGE_CONFIG_DIR.
2. Start Forge. Its default MCP listener is 127.0.0.1:8767 and local Manager is on port 8768.
3. Route an HTTPS origin you control to the MCP listener using your existing tunnel. The configured public origin must match. This repository does not create an external tunnel or move account credentials.
4. Add the HTTPS MCP endpoint ending in /mcp in your ChatGPT connection interface and complete OAuth. Host access and setup options depend on your account.
5. Use project_context to check the selected project, then try a read-only inspection before an editing task.

Keep local manager URLs and owner credentials private. Use the Manager to grant desktop access only when needed. Install and authorize the Playwright extension separately for existing Chrome tabs. When tool schemas change, refresh the connection tool catalog.
