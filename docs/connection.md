# Connect ChatGPT to Forge

## 1. Connect the local service to ChatGPT

1. Follow the source installation commands in the [README](../README.md#get-started). Create the project folder before running `init`. If you use `CHATGPTFORGE_CONFIG_DIR`, use the same value for every Forge command.
2. Start Forge with `node dist/forge-cli.js serve` from `runtime`. The default MCP listener is `127.0.0.1:8767`; the local Manager is `http://127.0.0.1:8768`.
3. Route an HTTPS origin you control to the MCP listener using your tunnel. It must match the public origin configured by `init`. Keep the Manager local; do not point the tunnel at port 8768.
4. Add the HTTPS MCP endpoint ending in `/mcp` in ChatGPT's connection interface and complete OAuth. Available connection options depend on your account. Installing a Chrome extension does not create this connection.
5. Select the Forge connection in ChatGPT. Ask it to call `project_context` and confirm the intended project before making changes.

## 2. Choose the extension for your workflow

| Workflow | What to install |
|---|---|
| Ordinary MCP code editing, shared memory or authorized Windows desktop tools | No Chrome extension required; configure the relevant local tools and permissions. |
| Continue queued handoffs in a new signed-in ChatGPT tab, or fill the project-plugin form from the Manager | **ChatGPTForge Continuation**, included in `runtime/browser-extension`. |
| Operate existing Chrome tabs through the Playwright gateway | Microsoft's **Playwright Extension**, plus the `playwright-browser` gateway configuration below. |
| Run an isolated Playwright browser | The separate `playwright` gateway and its browser dependencies; neither Chrome extension is required for this mode. |

The Forge extension is not a general browser-control extension. Playwright Extension does not replace Forge's continuation helper. Install both only if you need both workflows.

## 3. Install and pair ChatGPTForge Continuation

1. Keep Forge running. Open the Chrome profile where you are already signed in to ChatGPT.
2. Open `chrome://extensions`, turn on **Developer mode**, then select **Load unpacked**.
3. Select `runtime/browser-extension` inside your cloned or extracted ChatGPTForge repository. Select the folder containing `manifest.json`, not the root folder or the ZIP. The installed name is **ChatGPTForge Continuation**. This source-installation route does not require a Chrome Web Store listing.
4. Open `http://127.0.0.1:8768`. Expand **Settings → Chrome extension pairing** and copy the Chrome pairing code. UI labels follow your selected language.
5. Click the Forge extension's toolbar action to open its options (or open its details in `chrome://extensions` and choose extension options).
6. Set the local Manager address to `http://127.0.0.1:8768`, or the actual configured Manager port. The extension accepts an `http://127.0.0.1:PORT` address, not the public MCP URL, `localhost`, or port 8767.
7. Paste the pairing code, enable automatic continuation, save settings, then check now. Enabling continuation permits queued handoff prompts to be submitted in a new ChatGPT tab. The extension checks approximately every 30 seconds while Chrome is running.
8. With no queued job, the status should indicate **Connected, waiting for handoff** (`已連線，等待交接` in Traditional Chinese). Saving settings alone does not prove connectivity. If a job is already queued, checking can process it immediately.

The helper also handles project-plugin form requests from the Manager. Review the resulting ChatGPT form and complete its Create / Connect steps yourself. A filled form is not proof that the MCP connection is connected.

Keep the extension folder in place. After pulling an update that changes extension files, click **Reload** on its Chrome extensions card. Keep the pairing code private: it grants access to the local browser bridge and is neither a ChatGPT password nor a Playwright token.

### Troubleshooting the Forge extension

| Symptom | Action |
|---|---|
| Chrome cannot find a manifest | Extract the ZIP first and select `runtime/browser-extension`, where `manifest.json` lives. |
| Missing pairing code | Copy the code from the running Manager, paste it in extension options, and save. |
| Automatic continuation is disabled | Enable it and save before using Check now. |
| Settings are not saved | Save the current address, code and enabled checkbox, then check again. |
| Connection refused / failed | Confirm Forge is running and the Manager opens at the exact address entered in the extension. Do not use the public MCP URL. |
| HTTP 401 | Obtain the pairing code from the current Forge instance and save it again. |
| Server version is older / HTTP 404 | Update and restart Forge; reload the extension after updating its files. |
| Connected, waiting for handoff | The connection works; there is no queued handoff. This is not an error. |
| Submitted, waiting for ChatGPT to claim | Submission is not task completion. Confirm the new chat has the Forge connection and can claim the handoff. |
| Submission result unknown | Inspect the new ChatGPT tab and task receipt before retrying; do not send a duplicate blindly. |

## Optional: existing Chrome tab automation

This is separate from Forge Continuation. Follow Microsoft's [Playwright MCP documentation](https://github.com/microsoft/playwright-mcp#browser-extension) and install [Playwright Extension from the Chrome Web Store](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) in the Chrome profile you intend to use.

For the Forge CLI registration route, run the following in `runtime`, using the same Forge configuration directory as the running service. The commands install the previously validated MCP version and register the existing-tab gateway; they do not approve or launch it:

~~~powershell
npm install -g @playwright/mcp@0.0.80
node dist/forge-cli.js gateway list
node dist/forge-cli.js gateway add-playwright-browser
~~~

Skip `add-playwright-browser` if that ID is already listed. It registers the installed package with `--extension`; `add-playwright` instead creates an isolated browser configuration.

Approve only the tools you need. For example, this limited initial setup permits tab inspection and page snapshots:

~~~powershell
node dist/forge-cli.js gateway approve playwright-browser --read browser_tabs,browser_snapshot
~~~

Configure allowed site origins and any additional write tools for your actual task using `gateway origins` and `gateway approve`; a later approval command replaces the tool lists, so include all tools you want to retain. The initial origin policy is local-only. Restart Forge after changing the gateway configuration, refresh the host's tool catalog, then request a browser inspection through that gateway.

When the Playwright connection page appears, verify the requesting client, review the browser-access warning, and select the intended tab with **Allow & select**. This authorization is broader than a single test page and can expose signed-in browser state. Do not paste a Playwright token into Forge Continuation's pairing-code field.

If no connection page appears, check that you used `playwright-browser`, approved its tools, restarted Forge, installed Playwright Extension in the intended Chrome profile, and actually invoked a gateway browser tool. Installing an extension alone is not a completed browser connection.
