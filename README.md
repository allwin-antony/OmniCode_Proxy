# LM Bridge — Local AI Server Extension

> **Expose your IDE's internal language models as a local OpenAI-compatible HTTP API.**  
> Like Ollama, but powered by the AI models already inside your Antigravity / VS Code IDE.

## ✨ Features

- 🔌 **OpenAI-compatible API** — `/v1/chat/completions`, `/v1/models`
- 🦙 **Ollama-compatible API** — `/api/chat`, `/api/tags`
- 🎛️ **Control Panel** — Beautiful webview dashboard for managing everything
- 🔑 **API Token Security** — Generate, revoke, and manage Bearer tokens
- 📡 **Status Bar Widget** — Live server status, port, uptime at a glance
- 📊 **Request Logging** — Real-time log stream in the Control Panel + Output Channel
- ⚙️ **Configurable** — Port, host, CORS, auth, concurrency, timeout — all customizable
- 🔄 **Streaming** — Full SSE streaming support for real-time responses
- 🤖 **Auto-discovery** — Dynamically discovers all available IDE language models

## 🚀 Quick Start

### 1. Install & Activate
- Open the Extension in your Antigravity / VS Code IDE
- The extension activates automatically

### 2. Start the Server
- Open Command Palette (`Ctrl+Shift+P`)
- Run: **LM Bridge: Start Server**
- Or click the status bar item → Control Panel → Start

### 3. Generate an API Token
- Run: **LM Bridge: Open Control Panel**
- Click **+ Generate Token** in the API Tokens section
- Copy the token for use in your scripts

### 4. Make Requests

**curl:**
```bash
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

**Python (OpenAI SDK):**
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:11434/v1",
    api_key="YOUR_TOKEN"
)

response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

**Node.js:**
```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:11434/v1",
  apiKey: "YOUR_TOKEN",
});

const response = await client.chat.completions.create({
  model: "gemini-2.5-flash",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(response.choices[0].message.content);
```

## 📡 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | List all available models |
| `GET` | `/v1/models/:id` | Get a specific model |
| `POST` | `/v1/chat/completions` | Chat completion (streaming & non-streaming) |
| `GET` | `/health` | Server health check |
| `POST` | `/api/chat` | Ollama-compatible chat |
| `GET` | `/api/tags` | Ollama-compatible model list |

## ⚙️ Settings

All settings are accessible via VS Code Settings UI under `lmBridge.*`:

| Setting | Default | Description |
|---------|---------|-------------|
| `lmBridge.port` | `11434` | Server port |
| `lmBridge.host` | `127.0.0.1` | Bind address |
| `lmBridge.autoStart` | `false` | Auto-start on IDE launch |
| `lmBridge.authEnabled` | `true` | Require Bearer token |
| `lmBridge.defaultModel` | `""` | Default model if not specified |
| `lmBridge.corsOrigins` | `*` | Allowed CORS origins |
| `lmBridge.logLevel` | `info` | Log verbosity |
| `lmBridge.maxConcurrentRequests` | `5` | Max simultaneous requests |
| `lmBridge.requestTimeout` | `120000` | Request timeout (ms) |

## 🏗️ Architecture

```
External App / Script
    ↓ HTTP Request
┌─────────────────────────────────┐
│  LM Bridge Extension            │
│  ┌───────────────────────────┐  │
│  │  HTTP Server              │  │
│  │  ├─ Auth Middleware       │  │
│  │  ├─ Router                │  │
│  │  └─ LM Bridge Core       │  │
│  │     └─ vscode.lm API ──────── Internal Models (Gemini, etc.)
│  ├───────────────────────────┤  │
│  │  Control Panel (Webview)  │  │
│  │  Status Bar Widget        │  │
│  │  Token Manager            │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

## 🛠️ Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch for changes
npm run watch

# Press F5 in VS Code to launch Extension Development Host
```

## 📄 License

MIT
