# OmniCode Proxy — Local AI Server Extension

> **Expose your IDE's internal language models as a local OpenAI-compatible HTTP API.**  
> Like Ollama, but powered by the high-quality AI models already active and authenticated inside your IDE.

---

## ✨ Key Features

- 🔌 **OpenAI-Compatible Endpoints** — Standard `/v1/chat/completions` and `/v1/models` APIs out of the box.
- 🦙 **Ollama-Compatible Endpoints** — Drop-in `/api/chat` and `/api/tags` support for immediate CLI integration.
- 🎛️ **Webview Control Panel** — Premium dashboard interface to monitor uptime, server logs, request statistics, and developer configurations.
- 🔑 **Secure Token Authentication** — Native, encrypted bearer token management utilizing the IDE's secure storage (`SecretStorage`).
- 📡 **Status Bar Widget** — Real-time server status, bind host, port, and live request counting.
- 📊 **Real-time Logging** — Output log channel stream in the control panel + dedicated output console channel for easy API diagnostics.
- 🔄 **SSE Streaming Support** — Full Server-Sent Events (SSE) support for responsive, token-by-token text generation.
- 🤖 **Auto-Discovery** — Automatic detection and indexing of all available internal chat models.
- 🧱 **Graceful Sandbox Fallback** — Built-in sandbox mode that lets you test integrations seamlessly even without registered model providers.

---

## 🚀 Quick Start

### 1. Install & Launch
- Install the **OmniCode Proxy** extension inside your IDE.
- Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and search for **LM Bridge: Open Control Panel**.

### 2. Configure & Start Server
- Adjust your desired binding port (default: `11434`) and host interface.
- Click **Start Server** or run **LM Bridge: Start Server** from the Command Palette.

### 3. Generate secure API Tokens
- Click **+ Generate Token** in the API Tokens section.
- Copy your generated token (you won't be able to see the full value again for security reasons!).

### 4. Connect your scripts

#### 🔹 curl
```bash
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-lmb-...YOUR_TOKEN..." \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

#### 🔹 Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:11434/v1",
    api_key="sk-lmb-...YOUR_TOKEN..."
)

response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

#### 🔹 Node.js (OpenAI SDK)
```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:11434/v1",
  apiKey: "sk-lmb-...YOUR_TOKEN...",
});

const response = await client.chat.completions.create({
  model: "gemini-2.5-flash",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(response.choices[0].message.content);
```

---

## 📡 API Endpoints Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | Lists all discovered active language models |
| `GET` | `/v1/models/:id` | Returns details of a specific model |
| `POST` | `/v1/chat/completions` | OpenAI chat completion (supports streaming and non-streaming) |
| `GET` | `/health` | Server health check (returns active status, host, and port) |
| `POST` | `/api/chat` | Ollama-compatible chat completions interface |
| `GET` | `/api/tags` | Ollama-compatible active models tags listing |

---

## ⚙️ Configuration Properties

You can customize the extension behavior either from the **Control Panel UI** or directly in the VS Code Settings under the `lmBridge.*` workspace scope:

| Configuration | Default | Description |
|---------------|---------|-------------|
| `lmBridge.port` | `11434` | The local port the API server binds to. |
| `lmBridge.host` | `127.0.0.1` | Host interface. Bind to `127.0.0.1` (localhost only) or `0.0.0.0` (all local network interfaces). |
| `lmBridge.autoStart` | `false` | Automatically start the server on IDE launch. |
| `lmBridge.authEnabled` | `true` | Enforce API Bearer token authentication header checks. |
| `lmBridge.defaultModel` | `""` | Default fallback model name if the incoming request omits the `model` property. |
| `lmBridge.corsOrigins` | `*` | Custom CORS allowed origins list (comma-separated). |
| `lmBridge.logLevel` | `info` | Logs verbosity levels: `none`, `error`, `info`, or `debug` (verbose). |
| `lmBridge.maxConcurrentRequests` | `5` | Maximum number of parallel LLM inferences supported simultaneously. |
| `lmBridge.requestTimeout` | `120000` | Timeout threshold in milliseconds for model execution. |

---

## 🏗️ Technical Architecture

```
External Apps & Scripts (Python, Node, LLM Clients)
                   │
                   ▼ (HTTP Requests)
┌──────────────────────────────────────────────┐
│  OmniCode Proxy Extension                    │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │   HTTP server (Node/Express-like)       │  │
│  │   ├─ CORS & Logger Middlewares         │  │
│  │   ├─ Token Authentication Validator     │  │
│  │   └─ API Router                        │  │
│  └───────────────────┬────────────────────┘  │
│                      │                       │
│                      ▼                       │
│  ┌────────────────────────────────────────┐  │
│  │   Core Controller                      │  │
│  │   ├─ Token Manager (SecretStorage)     │  │
│  │   └─ Model Mapper / Proxy Resolver     │  │
│  └───────────────────┬────────────────────┘  │
│                      │                       │
│                      ▼                       │
│              vscode.lm APIs                  │
└──────────────────────┼───────────────────────┘
                       │
                       ▼ (Public API Boundary)
         Internal IDE Language Models
             (Gemini, Claude, etc.)
```

---

## 🛠️ Developer Setup & Compilation

### Requirements
- **Node.js** v18+
- **npm** v9+

### Quick Start Development
```bash
# Clone the repository
git clone https://github.com/allwin-antony/OmniCode_Proxy.git
cd OmniCode_Proxy

# Install necessary modules
npm install

# Compile TypeScript once
npm run compile

# Run the TypeScript compiler watcher in the background
npm run watch
```

#### Launching and Debugging:
1. Open the project root folder in your IDE workspace.
2. Navigate to the **Run & Debug** pane (`Ctrl+Shift+D`).
3. Select **Run Extension** and press **F5**. This launches an isolated *Extension Development Host* window.
4. Run `LM Bridge: Open Control Panel` or test endpoint curls against your running instance.

---

## 📄 License
Licensed under the [MIT License](file:///home/allwin.antony@acsiatech.com/Downloads/Model_Exposer/LICENSE).
