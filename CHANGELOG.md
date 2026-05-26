# Changelog

All notable changes to the **OmniCode Proxy** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0]

### Added
- **Dynamic Port Selection**: Quick Start code blocks (curl, Python, Node.js, and Ollama) now automatically reflect the currently configured server port and host in real-time.
- **Native VS Code Modal Confirmation**: Implemented native VS Code modal warnings when executing destructive actions like revoking all active API tokens (removing sandboxed browser dialog blocks).
- **Secure Token Authentication**: Bearer token security via VS Code's `SecretStorage` protecting local model API endpoints.
- **OpenAI & Ollama Endpoints**: High-performance HTTP server supporting `/v1/chat/completions`, `/v1/models`, `/api/chat`, and `/api/tags` with full Server-Sent Events (SSE) stream support.
- **Webview Control Panel**: Interactive, beautiful control dashboard showing logs, connection state, system stats, token management, and developer settings.
- **Auto-discovery**: Discovers internal IDE models dynamically using public Language Model APIs.
- **Sandbox Fallback Mode**: Graceful simulated response when running in isolated developer environments where no companion extensions are logged in.
- **Status Bar Integration**: Visual status widget indicating port, uptime, and active connection state at a glance.
