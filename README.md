# Giggal.ai MCP Server

Verify catch-all, accept-all, and SEG-protected email addresses without leaving Claude, ChatGPT, Cursor, VS Code, or any other MCP client. This is the official [Model Context Protocol](https://modelcontextprotocol.io) server for [Giggal.ai](https://giggal.ai), the catch-all email verification tool that confirms the mailboxes other verifiers write off as "risky" or "unknown."

```
MCP URL:  https://mcp.giggal.ai/mcp
```

## Why Giggal.ai

Most tools give up on the hard addresses. Giggal.ai runs a deep mailbox existence check over SMTP and returns a real deliverability result where others cannot:

- **Catch-all and accept-all domains** that accept every address, even for users who do not exist
- **SEG-protected inboxes** behind Proofpoint, Mimecast, and Barracuda that block the checks most verifiers rely on
- **Risky B2B contacts** that competitors flag and discard, around 30% of a typical list, recovered as deliverable

99% accuracy on standard business lists and bounce rates under 3%, straight from your AI assistant.

## Get an API key

Sign up at [emailverifier.giggal.ai](https://emailverifier.giggal.ai/sign-up) for **1,000 free verification credits, no card required**, then copy your key from the **Developer API** tab. Claude and ChatGPT connect over OAuth and need no key. The IDE and CLI clients below use the key as a `Bearer` token.

## Connect your AI client

### Claude

Add Giggal.ai as a custom connector. No config files, no API key.

1. Open **Settings → Connectors** (web or desktop).
2. Click **Add → Add custom connector**.
3. Name it **Giggal.ai**, paste the MCP URL, then click **Add**.
4. Open the **Giggal.ai** connector and click **Connect**.
5. Click **Allow** to grant `verify:read` (verify addresses, check credits, look up past verifications).

### ChatGPT

Add Giggal.ai as a custom plugin, connected over OAuth.

1. Open **Plugins** from the sidebar, then click the **+** in the top right.
2. Name it **Giggal.ai**, set **Server URL** to the MCP URL, choose **Authentication → OAuth**, tick the confirmation, then click **Create**.
3. Open the plugin, click **Connect**, then **Sign in with Giggal.ai**.
4. Click **Allow** to grant `verify:read`.

### Claude Code

```bash
claude mcp add --transport http --scope user giggal \
  https://mcp.giggal.ai/mcp \
  --header "Authorization: Bearer YOUR_API_KEY"
```

Already have a `giggal` server? Run `claude mcp remove giggal --scope user` first, then re-add.

### Cursor, Windsurf, and Cline

Add this to your MCP config file:

- Cursor: `~/.cursor/mcp.json` (or `.cursor/mcp.json` per project)
- Windsurf: `~/.codeium/windsurf/mcp_config.json`
- Cline: `cline_mcp_settings.json` (open it from the Cline MCP settings)

```json
{
  "mcpServers": {
    "giggal": {
      "url": "https://mcp.giggal.ai/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json`. VS Code uses `servers` instead of `mcpServers`:

```json
{
  "servers": {
    "giggal": {
      "url": "https://mcp.giggal.ai/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

### Zed

Add to `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "giggal": {
      "source": "custom",
      "url": "https://mcp.giggal.ai/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.giggal]
url = "https://mcp.giggal.ai/mcp"
bearer_token_env_var = "GIGGAL_API_KEY"
```

Codex reads the key from an env var. Set it and reload your shell, then fully quit and reopen Codex:

```bash
echo 'export GIGGAL_API_KEY="tp_live_..."' >> ~/.zshrc
source ~/.zshrc
```

---

Restart the client after adding, then just ask:

> Is info@giggal.ai deliverable?

## Tools

| Tool | What it does |
|---|---|
| `verify_emails` | Verify a single address or a whole list and get a clear valid or invalid result, including catch-all and accept-all domains other tools give up on |
| `get_verification_details` | Fetch the full breakdown for a job: per-address status, reason codes, and deliverability scoring |
| `get_credit_balance` | Check remaining verification credits before a large run |

All tools are read only.

## What this service does

- Speaks the Model Context Protocol so AI assistants can call the tools above
- Serves an OpenAPI 3.1 spec so ChatGPT Custom GPTs (GPT Actions) can use it
- Runs an OAuth 2.1 authorization server so AI clients can authenticate users
- Wraps the Giggal.ai verification API and never re-implements verification logic

## Run it locally (self-host)

Prefer to run your own instance instead of the hosted server? The `giggal-mcp` command is a small stdio server that calls the public Giggal.ai API with your own Developer API key. No database, no OAuth, nothing to host.

**From source:**

```bash
npm install
npm run build
GIGGAL_API_KEY=tp_live_... npm run start:local
```

**With Docker:**

```bash
docker build -t giggal-mcp .
docker run -i --rm -e GIGGAL_API_KEY=tp_live_... giggal-mcp
```

**In an MCP client** (point it at your locally built copy):

```json
{
  "mcpServers": {
    "giggal": {
      "command": "node",
      "args": ["/path/to/giggal-mcp/dist/local/index.js"],
      "env": { "GIGGAL_API_KEY": "tp_live_..." }
    }
  }
}
```

Same three tools as the hosted server. `GIGGAL_API_BASE` optionally overrides the API base (defaults to `https://api.giggal.ai/v1`).

## About this repository

This repo powers both the **hosted** server at `https://mcp.giggal.ai/mcp` (OAuth, zero setup) and the **local** stdio server above (`giggal-mcp`, your own API key). Both expose the same three tools and call the Giggal.ai verification API to do the actual work. It is published for transparency.

## Endpoints

The hosted server exposes:

- `POST /mcp` MCP JSON-RPC (main protocol endpoint)
- `GET /mcp` MCP SSE stream (server to client notifications)
- `GET /openapi.json` OpenAPI 3.1 spec (for GPT Actions)
- `POST /oauth/register` Dynamic Client Registration (RFC 7591)
- `GET /oauth/authorize` User consent screen
- `POST /oauth/token` Access token exchange
- `POST /oauth/revoke` Revoke a token
- `GET /.well-known/oauth-authorization-server` Server metadata
- `GET /health` Health check

## License

MIT. See [LICENSE](./LICENSE).
