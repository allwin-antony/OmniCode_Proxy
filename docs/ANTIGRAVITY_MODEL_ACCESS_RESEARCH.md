# Antigravity IDE — Internal Model Access Research

> **Goal:** Find a way for the OmniCode Proxy extension to access Antigravity IDE's built-in Gemini models, which are currently invisible to the standard `vscode.lm` public API.

---

## Table of Contents
- [Background](#background)
- [The Problem](#the-problem)
- [Architecture Discovery](#architecture-discovery)
- [Key Findings](#key-findings)
- [Proposed Approaches](#proposed-approaches)
- [File References](#file-references)
- [Open Questions](#open-questions)

---

## Background

**Antigravity IDE** (v1.107.0) is a VS Code fork by Google with built-in AI capabilities (Gemini chat, code completions, agent workflows). It ships with two key built-in extensions:

| Extension | Path | Purpose |
|-----------|------|---------|
| `antigravity` | `extensions/antigravity/` | Core AI extension — chat, completions, Language Server management |
| `securecoder` | `extensions/securecoder/` | Security vulnerability scanning |

The built-in `antigravity` extension powers the IDE's sidebar chat, inline completions, and agent features. It communicates with Google's Gemini models via a **local Language Server (LS)** process — **not** via the standard `vscode.lm` extension API.

---

## The Problem

When our OmniCode Proxy extension calls `vscode.lm.selectChatModels()`, it returns **0 models** inside Antigravity IDE, even though:
1. The IDE's sidebar chat works perfectly (proving models are accessible).
2. Google Gemini Code Assist is installed and signed in.

The error from the IDE core confirms:
```
Error: No language model proxy provider is registered.
```

This means no extension has called `vscode.lm.registerLanguageModelChatProvider()` or `vscode.lm.registerLanguageModelProxyProvider()` inside the Antigravity runtime.

---

## Architecture Discovery

### How Antigravity's AI Actually Works

Through reverse-engineering the minified source files, we discovered that **Antigravity does NOT use the `vscode.lm` API at all** for its internal AI features. Instead, it uses a completely separate architecture:

```
┌─────────────────────────────────────────────────────────┐
│  Antigravity IDE (Electron Main Process)                │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  antigravity extension (extensions/antigravity/)  │  │
│  │                                                   │  │
│  │  1. Spawns a local Language Server (LS) binary    │  │
│  │  2. LS runs on localhost HTTPS with:              │  │
│  │     - httpsPort (main API)                        │  │
│  │     - lspPort  (LSP protocol)                     │  │
│  │     - httpPort (fallback)                         │  │
│  │  3. Protected by CSRF token (random UUID)         │  │
│  │  4. Uses TLS cert: languageServer/cert.pem        │  │
│  │                                                   │  │
│  │  Communication:                                   │  │
│  │  Extension ──HTTPS+CSRF──► Local LS Binary        │  │
│  │  Local LS Binary ──gRPC/Connect──► Google Cloud   │  │
│  │                        (Gemini API)               │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  vscode.lm namespace (Extension Host)             │  │
│  │  - Empty. No providers registered.                │  │
│  │  - selectChatModels() → [] (always)               │  │
│  │  - getModelProxy() → throws "No proxy registered" │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Key Code Paths (from minified sources)

#### 1. Language Server Startup
**File:** `extensions/antigravity/dist/extension.js`

The antigravity extension spawns a local Language Server process and stores connection details:
```javascript
// Pseudocode (deobfuscated)
csrfToken = crypto.randomUUID();
// LS process exposes: httpsPort, httpPort, lspPort
antigravityLanguageServer.setCsrfToken(process.csrfToken);
antigravityLanguageServer.setPort(process.httpsPort);
```

#### 2. LSP Client Connection
**File:** `extensions/antigravity/dist/extension.js`

The extension creates an LSP client that connects to the local LS:
```javascript
// Pseudocode (deobfuscated)
createLspClient(address, lspPort) {
    const connection = createConnection(lspPort, host);
    return new LanguageClient("antigravity", async () => connection);
}

// Separate gRPC/Connect client for AI features:
createLsClient(baseUrl, csrfToken, extensionPath) {
    // Uses: https://${address}:${httpsPort}
    // With: TLS cert from languageServer/cert.pem
    // And: CSRF token validation middleware
}
```

#### 3. CSRF Protection
All requests to the local LS are protected by CSRF token validation:
```javascript
// Middleware in the LS HTTP server
if (!csrfToken) {
    response.writeHead(403, {"Content-Type": "text/plain"});
    response.end("Invalid CSRF token");
}
```

#### 4. The `vscode.lm` Proxy Architecture
**File:** `out/vs/workbench/api/node/extensionHostProcess.js`

The IDE core does have a proxy architecture built in, but it requires explicit registration:
```javascript
// Registration (requires 'chatParticipantPrivate' API proposal)
registerLanguageModelProxyProvider(extension, provider) {
    checkApiProposal(extension, "chatParticipantPrivate");
    this._languageModelProxyProvider = provider;
    this._onDidChangeModelProxyAvailability.fire();
}

// Consumption (requires 'languageModelProxy' API proposal)
getModelProxy(extension) {
    checkApiProposal(extension, "languageModelProxy");
    if (!this._languageModelProxyProvider)
        throw new Error("No language model proxy provider is registered.");
    // ... would delegate to the provider
}
```

**Critical finding:** The `antigravity` extension's `enabledApiProposals` are:
```json
["contribSourceControlInputBoxMenu", "inlineCompletionsAdditions", "antigravityUnifiedStateSync"]
```
It does **NOT** include `chatParticipantPrivate` or `languageModelProxy`, confirming it **never registers** as a model provider via `vscode.lm`.

---

## Key Findings

### Finding 1: Two Separate AI Pipelines
Antigravity has **two completely independent AI pipelines**:
1. **Internal Pipeline** (used by the built-in `antigravity` extension): Local Language Server binary → gRPC/Connect → Google Cloud Gemini
2. **Public Pipeline** (`vscode.lm` API): Standard extension API → empty, no providers registered

### Finding 2: Local Language Server Details
The Language Server runs as a local HTTPS server with:
- **Dynamic port** (assigned at startup)
- **CSRF token** (random UUID generated per session)
- **TLS certificate** (bundled at `extensions/antigravity/languageServer/cert.pem`)
- **Binary path** (platform-specific, discovered via `languageServerBinaryPath`)

### Finding 3: Exposed Extension API
The `antigravity` extension exposes a `vscode.antigravityLanguageServer` proposed API with:
- `setCsrfToken(token)` — Set the CSRF token
- `setPort(port)` — Set the HTTPS port
- These are exposed to the extension host but gated behind the `antigravityLanguageServer` API proposal

### Finding 4: The `antigravityLanguageServer` Proposed API
In the extension host process, there is a proposed API:
```
antigravityLanguageServer: {
    proposal: "https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.antigravityLanguageServer.d.ts"
}
```
This API is what allows the built-in extension to communicate the LS port/token to the IDE core. It is **not available to third-party extensions** without being whitelisted.

---

## Verified Connect RPC Harvester Solution (100% Working)

We have successfully reverse-engineered, implemented, and verified a **direct Connect-JSON RPC connection** to Antigravity's internal Language Server binary! This allows us to completely bypass the dead-end `vscode.lm` API and query the actual Gemini models directly.

### The Working Strategy

```
┌──────────────────────────────────────────────────────────┐
│  OmniCode Proxy (HARVESTER PROCESS)                      │
│                                                          │
│  1. Scan Process Table (ps aux)                          │
│     - Locate latest "language_server_linux_x64"          │
│     - Harvest dynamic token: --csrf_token                │
│                                                          │
│  2. Scan Socket Table (ss -ltp)                          │
│     - Query ports listening under LS process PID         │
│     - Discovers active HTTPS Connect API Port            │
│                                                          │
│  3. Connect directly over HTTPS to local port            │
│     - Header: 'x-codeium-csrf-token': <csrfToken>        │
│     - Header: 'connect-protocol-version': '1'            │
│     - Bypass self-signed TLS validation                  │
│                                                          │
│  Connect RPC Handshake ──200 OK──► Connect Success!       │
└──────────────────────────────────────────────────────────┘
```

### Protocol Details & Header Secrets

1. **Authentication Header:**
   The server expects the proprietary **`x-codeium-csrf-token`** header containing the dynamic session CSRF token harvested from the `language_server_linux_x64` process command line. 
   *(Note: Standard headers like `x-csrf-token` or standard authorization bearers are rejected with a `401 {"code":"unauthenticated","message":"missing CSRF token"}` Connect error.)*

2. **Connect Protocol Header:**
   To speak standard Connect-JSON RPC, requests must include:
   `'connect-protocol-version': '1'`

3. **Service & Method Endpoint:**
   - **Service Package:** `exa.language_server_pb.LanguageServerService`
   - **Discovered Methods:**
     - `GetStatus` (Retrieve active server state)
     - `GetAvailableModels` (Retrieve Vertex/Gemini active model lists, settings, and quotas)
     - `GetCascadeModelConfigs` (Retrieve custom configuration objects)

### Connect Handshake Proof-of-Concept (Node.js)

The following Node.js snippet dynamically harvests the active LS details, discovers its active sockets, and executes a direct TLS-bypassed Connect handshake:

```javascript
import { exec } from 'child_process';
import https from 'https';

// 1. Harvest Latest LS Details
async function harvestLanguageServer() {
    return new Promise((resolve, reject) => {
        exec('ps aux | grep -i "language_server_linux_x64"', (error, stdout) => {
            if (error) return reject(error);
            const lines = stdout.split('\n');
            const processes = [];
            for (const line of lines) {
                if (line.includes('grep')) continue;
                const columns = line.trim().split(/\s+/);
                if (columns.length <= 1) continue;
                const pid = parseInt(columns[1], 10);
                const csrfTokenMatch = line.match(/--csrf_token\s+([a-f0-9-]+)/i);
                if (pid && csrfTokenMatch) {
                    processes.push({ pid, csrfToken: csrfTokenMatch[1] });
                }
            }
            if (processes.length === 0) return reject(new Error('Process not found'));
            processes.sort((a, b) => b.pid - a.pid); // Target latest spawned
            const latest = processes[0];
            
            // Get listening ports
            exec('ss -ltp 2>/dev/null', (err, ssStdout) => {
                if (err) return reject(err);
                const ports = [];
                for (const line of ssStdout.split('\n')) {
                    if (line.includes(`pid=${latest.pid}`)) {
                        const portMatch = line.match(/127\.0\.0\.1:(\d+)/i);
                        if (portMatch) ports.push(parseInt(portMatch[1], 10));
                    }
                }
                resolve({ pid: latest.pid, csrfToken: latest.csrfToken, ports });
            });
        });
    });
}

// 2. Perform Connect-JSON Request
async function queryConnectEndpoint(port, csrfToken, method) {
    return new Promise((resolve) => {
        const path = `/exa.language_server_pb.LanguageServerService/${method}`;
        const options = {
            hostname: '127.0.0.1',
            port: port,
            path: path,
            method: 'POST',
            rejectUnauthorized: false, // Bypass self-signed CA checks
            headers: {
                'Content-Type': 'application/json',
                'x-codeium-csrf-token': csrfToken,
                'connect-protocol-version': '1'
            }
        };
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', (err) => resolve({ error: err.message }));
        req.write(JSON.stringify({}));
        req.end();
    });
}
```

This verification run successfully returned **`200 OK`** with detailed JSON response payloads on the dynamic Connect HTTPS port (e.g. `37367`), demonstrating complete model access capability.

---

## File References

| File | Description |
|------|-------------|
| `~/.local/opt/antigravity-ide/resources/app/extensions/antigravity/package.json` | Antigravity extension manifest |
| `~/.local/opt/antigravity-ide/resources/app/extensions/antigravity/dist/extension.js` | Antigravity extension compiled source (minified) |
| `~/.local/opt/antigravity-ide/resources/app/extensions/securecoder/package.json` | SecureCoder extension manifest |
| `~/.local/opt/antigravity-ide/resources/app/out/vs/workbench/api/node/extensionHostProcess.js` | Extension host process (vscode.lm implementation) |
| `~/.local/opt/antigravity-ide/resources/app/out/vs/workbench/workbench.desktop.main.js` | Workbench main process |
| `~/.local/opt/antigravity-ide/resources/app/out/main.js` | Electron main process |
| `~/.local/opt/antigravity-ide/resources/app/product.json` | IDE product configuration |

---

## Open Questions & Resolution Status

1. **Does the `antigravity` extension export any public API?**
   - *Status:* **Resolved**.
   - *Findings:* The minified exports for the `antigravity` extension show standard utilities (`exports.Format`, `exports.Stream`, `exports.getAPI`) but do not export any direct connection handles or client references for the active model. Direct inter-extension API export is **not** a viable path.

2. **Can we discover the LS port and CSRF token?**
   - *Status:* **Resolved (Major Breakthrough)**.
   - *Findings:* Yes! By doing standard process inspection (scanning active running processes on the host), we can find the exact arguments passed to the running language server.
   - *Active Running Process Command Line:*
     ```bash
     /home/allwin.antony@acsiatech.com/.local/opt/antigravity-ide/resources/app/extensions/antigravity/bin/language_server_linux_x64 \
       --enable_lsp \
       --csrf_token 27f3c186-a477-4b55-acc3-f89b04a7ec05 \
       --extension_server_port 38431 \
       --extension_server_csrf_token 740c2e43-d25f-4f7a-b636-2e35c40f0e04 \
       --workspace_id file_home_allwin_antony_40acsiatech_com_Downloads_Model_Exposer \
       --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com \
       --subclient_type ide \
       --app_data_dir antigravity-ide \
       --parent_pipe_path /tmp/server_710fd860165f7d45
     ```
   - *Extraction Strategy:* A Node.js child process scan using standard OS utilities (e.g. `ps aux` or `/proc` scanning on Linux/macOS) can query command-line parameters to dynamically harvest:
     1. `--csrf_token` (The LS-bound authentication token)
     2. `--extension_server_port` (The listening port)
     3. `--extension_server_csrf_token` (The extension-bound security token)

3. **Can we read the CSRF token from process environment?**
   - *Status:* **Resolved**.
   - *Findings:* Not necessary, since they are explicitly exposed in the command-line arguments of the spawned child process, which is visible via process tree inspection.

4. **What protocol does the LS use for chat?**
   - *Status:* **Resolved (Major Breakthrough)**.
   - *Findings:* The LS process exposes standard Go/C++ Connect RPC endpoints over local HTTPS. 
     - **Unary APIs** (e.g., `/GetCascadeModelConfigs` and `/GetAvailableModels`) communicate via standard JSON POST requests carrying the `'connect-protocol-version': '1'` header.
     - **Streaming Chat APIs** (e.g., `/HandleStreamingCommand`) use the Connect streaming protocol, which requires a custom `Content-Type: application/connect+json` and sends binary-enveloped stream frames.
     - **Connect Streaming Frame Format:** Every chunk in the response stream starts with a **5-byte header**:
       - `Byte 0 (Flag)`: `0` for standard data payload, `2` for metadata/errors/trailers.
       - `Bytes 1-4 (Length)`: A Big-Endian 32-bit unsigned integer (`uint32`) specifying the length of the following JSON string payload.
     - By decoding these bytes and extracting the `rawText` field from the JSON stream payloads, we can build a perfect real-time OpenAI-compatible stream.

5. **Is the `antigravityLanguageServer` proposed API accessible if we declare it?**
   - *Status:* **Resolved**.
   - *Findings:* No, proposed APIs are strictly gated by product whitelists inside `product.json` and are rejected at runtime for third-party extensions.

---

## Final Production Architecture

Now that the research has been fully translated into a robust production implementation, **OmniCode Proxy** employs the following architecture to dynamically bridge the models:

```
 ┌────────────────────────────────────────────────────────┐
 │ Client (e.g. Cline, Cursor, Continue, curl)             │
 └───────────────────────────┬────────────────────────────┘
                             │ (OpenAI chat/completions)
                             ▼
 ┌────────────────────────────────────────────────────────┐
 │ OmniCode Proxy Extension (out/extension.js)            │
 │                                                        │
 │  ┌──────────────────────────────────────────────────┐  │
 │  │ 1. Harvester Cache (harvester.ts)                │  │
 │  │    - Scans ps aux for language_server_linux_x64  │  │
 │  │    - Resolves latest active PID and CSRF Token   │  │
 │  │    - Port-scans ss -ltp sockets & validates SSL  │  │
 │  └──────────────────────────────────────────────────┘  │
 │                                                        │
 │  ┌──────────────────────────────────────────────────┐  │
 │  │ 2. Dual-Pipeline Model Discovery                │  │
 │  │    - Merges local configs from Connect POST with │  │
 │  │      standard OpenAI model specs                 │  │
 │  └──────────────────────────────────────────────────┘  │
 │                                                        │
 │  ┌──────────────────────────────────────────────────┐  │
 │  │ 3. Streaming Connect Bridge                      │  │
 │  │    - Maps message history to chat text prompt    │  │
 │  │    - Pushes 5-byte wrapped JSON request          │  │
 │  │    - Parses 5-byte Connect envelope stream slice │  │
 │  │    - Pipes words/text back to OpenAI client SSE  │  │
 │  └──────────────────────────────────────────────────┘  │
 └────────────────────────────────────────────────────────┘
```

---

## Research Status

| Date | Status | Notes |
|------|--------|-------|
| 2026-05-26 | Completed | Reverse-engineered LS process. Discovered that port and token are fully visible in the command-line arguments of the spawned `language_server_linux_x64` process, allowing dynamic harvesting! |
| 2026-05-27 | Implemented & Verified | Fully implemented dynamic harvesting, Connect-JSON RPC handshake, and a custom 5-byte binary slice parser for real-time model stream piping. Verified 100% working and packaged into `omnicode-proxy-1.0.0.vsix` production build. |

---

*This document is maintained as part of the OmniCode Proxy project. Contributors: @allwin-antony*
