# OmniCode Proxy — Local AI Server Extension

> **Expose your IDE's internal language models as a local OpenAI/Ollama-compatible HTTP API.**  
> Like Ollama, but powered by the premium high-quality Gemini models already active and authenticated inside your Google Antigravity or vanilla VS Code workspace.

---

## 📖 Table of Contents
- [Key Features](#-key-features)
- [Requirements](#-requirements)
- [How it Works (The Basic Explanation)](#-how-it-works-the-basic-explanation)
- [Quick Start](#-quick-start)
- [API Endpoints Reference](#-api-endpoints-reference)
- [Configuration Properties](#️-configuration-properties)
- [Technical Architecture](#️-technical-architecture)
- [License](#-license)

---

## ✨ Key Features

- 🔄 **Smart Dual-Pipeline Engine** — Automatically detects the environment. Uses vanilla VS Code `vscode.lm` APIs when available, and seamlessly switches to the high-performance direct Connect RPC harvester inside Google Antigravity.
- 🔌 **OpenAI-Compatible Endpoints** — Standard `/v1/chat/completions` and `/v1/models` APIs out of the box. Compatible with client tools like Cline, Continue, Cursor, or your own Python/Node.js scripts.
- 🦙 **Ollama-Compatible Endpoints** — Drop-in `/api/chat` and `/api/tags` support for immediate CLI integration.
- 🎛️ **Premium Webview Control Panel** — Rich, modern dashboard interface to monitor server status, view logs in real-time, inspect discovered models, and manage secure API keys.
- 🔑 **Secure Token Authentication** — Native, encrypted bearer token management utilizing the IDE's secure storage (`SecretStorage`).
- 📡 **Status Bar Widget** — Real-time server status, binding address, active port, and live request counting.
- 📊 **Real-time Logging** — Log console output channel in the control panel + dedicated output console channel for easy API diagnostics.
- 🧱 **Graceful Sandbox Fallback** — Built-in sandbox mode that lets you test integrations and endpoints seamlessly even without active logged-in models.

---

## 📋 Requirements & OS Compatibility

- **Visual Studio Code** v1.93.0 or higher, OR **Google Antigravity IDE** v1.107.0+.
- An active AI provider extension installed and authenticated in your IDE (e.g., Google Gemini Code Assist, GitHub Copilot, etc.).

### 💻 Operating System Support
Because Omni Bridge dynamically detects your environment, its features depend slightly on your OS:
- **Standard VS Code Pipeline (`vscode.lm`)**: 🟢 Fully supported on **Windows, macOS, and Linux**.
- **Antigravity Direct Connect Bypass**: 🐧 Currently supported **only on Linux**. This is because the background process harvester relies on Linux-specific commands (`ps aux`, `ss`) and virtual file systems (`/proc`) to locate the internal language server and its secure sockets.

---

## 💡 How it Works (The Basic Explanation)

Normally, third-party extensions cannot access the built-in Gemini models inside Antigravity IDE because they run in a secure, sandboxed container and do not register themselves to public extension APIs. 

**OmniCode Proxy bypasses this limitation dynamically:**

1. **Process & Socket Harvesting**: The extension automatically scans the running processes (`ps aux`) on your local machine to find the active Antigravity Language Server binary (`language_server_linux_x64`).
2. **Secure Token Extraction**: It harvests the highly secure, dynamic session token (`--csrf_token`) passed to the process at startup.
3. **Socket Discovery & SSL Probing**: It scans listening ports (`ss -ltp`) belonging to that process and dynamically probes them to find the correct local SSL port.
4. **Direct Bridge Handshake**: It establishes a direct TLS-bypassed HTTPS tunnel to the local server, communicating over the **Connect protocol** (a lightweight gRPC-compatible JSON format).
5. **Streaming Slice Decoder**: When you prompt the model, the proxy converts your standard OpenAI request into a **5-byte enveloped Connect stream command**, reads the incoming binary chunks frame-by-frame, extracts the words, and streams them back to your client instantly.

This translates to complete, latency-free access to internal premium Gemini models, right from your standard developer tools!

---

## 🚀 Quick Start

### 1. Install & Launch
- Install the **OmniCode Proxy** extension (`omnicode-proxy-1.1.1.vsix`) inside your IDE.
- Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and search for **Omni Bridge: Open Control Panel**.

### 2. Configure & Start Server
- Adjust your desired binding port (default: `11434`) and host interface.
- Click **Start Server** or run **Omni Bridge: Start Server** from the Command Palette.

### 3. Generate secure API Tokens
- Navigate to the **API Tokens** tab in the Control Panel dashboard and click **+ Generate Token**.
- Copy the generated bearer key (for security reasons, this is only shown once!).

### 4. Connect your scripts

#### 🔹 curl
```bash
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-lmb-...YOUR_TOKEN..." \
  -d '{
    "model": "gemini-3.5-flash-low",
    "stream": true,
    "messages": [{"role": "user", "content": "Tell me a joke!"}]
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
    model="gemini-3.5-flash-low",
    messages=[{"role": "user", "content": "Explain quantum computing in one sentence."}]
)
print(response.choices[0].message.content)
```

#### 🔹 Cline / VS Code Extensions Configuration
Configure OmniCode Proxy in client extensions as an OpenAI-compatible provider:
- **Base URL**: `http://localhost:11434/v1`
- **API Key**: `sk-lmb-...YOUR_TOKEN...`
- **Model ID**: `gemini-3.5-flash-low` (or any model listed under the control panel's Discovered Models tab).

---

## 📡 API Endpoints Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | Lists all discovered active language models (harvested or registered) |
| `GET` | `/v1/models/:id` | Returns details of a specific model |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completion (supports real-time stream decoding) |
| `GET` | `/health` | Server health check (returns active status, host, and port) |
| `POST` | `/api/chat` | Ollama-compatible chat completions interface |
| `GET` | `/api/tags` | Ollama-compatible active models tags listing |

---

## ⚙️ Configuration Properties

You can customize server behaviors either from the **Control Panel UI** or directly in the VS Code Settings under the `omniBridge.*` workspace scope:

| Configuration | Default | Description |
|---------------|---------|-------------|
| `omniBridge.port` | `11434` | The local port the API server binds to. |
| `omniBridge.host` | `127.0.0.1` | Host interface. Bind to `127.0.0.1` (localhost only) or `0.0.0.0` (all local network interfaces). |
| `omniBridge.autoStart` | `false` | Automatically start the server on IDE launch. |
| `omniBridge.authEnabled` | `true` | Enforce API Bearer token authentication header checks. |
| `omniBridge.defaultModel` | `""` | Default fallback model name if the incoming request omits the `model` property. |
| `omniBridge.corsOrigins` | `*` | Custom CORS allowed origins list (comma-separated). |
| `omniBridge.logLevel` | `info` | Logs verbosity levels: `none`, `error`, `info`, or `debug` (verbose). |
| `omniBridge.maxConcurrentRequests` | `5` | Maximum number of parallel LLM inferences supported simultaneously. |
| `omniBridge.requestTimeout` | `120000` | Timeout threshold in milliseconds for model execution. |

---

## 🏗️ Technical Architecture

OmniCode Proxy is built with a dual-layer abstraction framework:

```
┌────────────────────────────────────────────────────────┐
│ Client Apps (Cline, Cursor, Python/Node, curl, etc.)   │
└───────────────────────────┬────────────────────────────┘
                            │ (HTTP / OpenAI Protocol)
                            ▼
┌────────────────────────────────────────────────────────┐
│              OMNICODE PROXY EXTENSION                  │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ 1. Local HTTP API Server (port: 11434)           │  │
│  │    - Routes: /v1/chat/completions, /v1/models    │  │
│  │    - Token validation & CORS filtering           │  │
│  └────────────────────────┬─────────────────────────┘  │
│                           │                            │
│                           ▼ (Dual-Pipeline Router)     │
│  ┌──────────────────────────────────────────────────┐  │
│  │ 2. Pipeline 1: Standard VS Code (vscode.lm)     │  │
│  │    - Active in vanilla VS Code                   │  │
│  │    - Queries registered third-party providers    │  │
│  └──────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────┐  │
│  │ 3. Pipeline 2: Antigravity Direct Connect RPC    │  │
│  │    - Scans active process table (`ps aux`)        │  │
│  │    - Extracts dynamic CSRF session keys          │  │
│  │    - Dynamic socket probing via local `ss` lookups│  │
│  │    - TLS cert bypassed local HTTPS Handshake      │  │
│  │    - 5-byte Connect streaming binary slice parser │  │
│  └────────────────────────┬─────────────────────────┘  │
└───────────────────────────┼────────────────────────────┘
                            │
                            ▼ (Direct Connect Tunnel)
            Antigravity Local Language Server
             (language_server_linux_x64)
```

---


## 📄 License
Licensed under the [MIT License].
