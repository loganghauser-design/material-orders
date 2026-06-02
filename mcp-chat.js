// Google Chat MCP connector — mounted on the existing Express app.
//
// Exposes a remote MCP server (Streamable HTTP, JSON-RPC) at  POST /mcp/<token>
// that lets Claude read and send Google Chat messages AS logan@buildoly.com,
// using a stored OAuth refresh token (same pattern as the Gmail integration).
//
// The protocol surface is small and stable, so we hand-roll the JSON-RPC instead
// of pulling in the MCP SDK (keeps the dependency list at zero additions).
//
// Required env vars (set on Railway):
//   CHAT_MCP_TOKEN      — long random string; baked into the connector URL path
//   CHAT_REFRESH_TOKEN  — from `node scripts/get-chat-token.js`
//   CHAT_CLIENT_ID      — OAuth client id   (falls back to GMAIL_CLIENT_ID)
//   CHAT_CLIENT_SECRET  — OAuth client secret (falls back to GMAIL_CLIENT_SECRET)

const { google } = require('googleapis');
const crypto = require('crypto');

const SERVER_NAME = 'google-chat';
const SERVER_VERSION = '1.0.0';
const DEFAULT_PROTOCOL = '2025-06-18';

// ---- Google Chat client (user auth, acts as you) ---------------------------

const MCP_TOKEN = process.env.CHAT_MCP_TOKEN;
const CLIENT_ID = process.env.CHAT_CLIENT_ID || process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.CHAT_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.CHAT_REFRESH_TOKEN;
const chatEnabled = !!(MCP_TOKEN && CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);

let chatClient = null;
if (chatEnabled) {
  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: REFRESH_TOKEN });
  chatClient = google.chat({ version: 'v1', auth: oauth2 });
}

// ---- helpers ---------------------------------------------------------------

// Normalize a space argument: accept "spaces/AAA", a bare id "AAA", or a
// display name to match (case-insensitive) against the spaces you belong to.
async function resolveSpace(input) {
  if (!input) throw new Error('A "space" is required (display name or spaces/ID).');
  const raw = String(input).trim();
  if (raw.startsWith('spaces/')) return raw;
  if (/^[A-Za-z0-9_-]+$/.test(raw) && !raw.includes(' ')) return `spaces/${raw}`;
  // treat as a display name — look it up
  const spaces = await listAllSpaces();
  const hit = spaces.find(s => (s.displayName || '').toLowerCase() === raw.toLowerCase());
  if (hit) return hit.name;
  const partial = spaces.find(s => (s.displayName || '').toLowerCase().includes(raw.toLowerCase()));
  if (partial) return partial.name;
  throw new Error(`No space found matching "${raw}". Use list_spaces to see exact names.`);
}

async function listAllSpaces() {
  const out = [];
  let pageToken;
  do {
    const { data } = await chatClient.spaces.list({ pageSize: 100, pageToken });
    (data.spaces || []).forEach(s => out.push(s));
    pageToken = data.nextPageToken;
  } while (pageToken && out.length < 300);
  return out;
}

function spaceLabel(s) {
  const kind = s.spaceType || s.type || 'SPACE';
  const name = s.displayName || (kind === 'DIRECT_MESSAGE' ? '(direct message)' : '(unnamed)');
  return `${name} [${kind}] — ${s.name}`;
}

function fmtMessage(m) {
  const who = (m.sender && (m.sender.displayName || m.sender.name)) || 'unknown';
  const when = m.createTime || '';
  const text = m.text || (m.formattedText || '') || '(no text — card or attachment)';
  return `• ${when}  ${who}\n  ${text.replace(/\n/g, '\n  ')}\n  id: ${m.name}`;
}

// ---- tool definitions ------------------------------------------------------

const TOOLS = [
  {
    name: 'list_spaces',
    description: 'List the Google Chat spaces and direct messages you belong to. Returns each space\'s display name, type, and its spaces/ID (needed by the other tools).',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional case-insensitive substring to filter by display name.' },
      },
    },
  },
  {
    name: 'list_messages',
    description: 'List recent messages in a Google Chat space, newest first. Accepts a space display name or spaces/ID.',
    inputSchema: {
      type: 'object',
      properties: {
        space: { type: 'string', description: 'Space display name or spaces/ID.' },
        limit: { type: 'number', description: 'Max messages to return (default 25, max 100).' },
      },
      required: ['space'],
    },
  },
  {
    name: 'get_message',
    description: 'Fetch a single Google Chat message by its full resource name (spaces/X/messages/Y).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full message resource name, e.g. spaces/AAA/messages/BBB.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'search_messages',
    description: 'Search recent messages for text. The Google Chat API has no native text search, so this scans recent messages (in one space, or across your spaces) and substring-matches. Best for recent conversations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to look for (case-insensitive).' },
        space: { type: 'string', description: 'Optional: limit to one space (display name or spaces/ID). Omit to scan across spaces.' },
        limit: { type: 'number', description: 'Max matches to return (default 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to a Google Chat space AS YOU. Optionally reply within an existing thread.',
    inputSchema: {
      type: 'object',
      properties: {
        space: { type: 'string', description: 'Space display name or spaces/ID.' },
        text: { type: 'string', description: 'Message text. Supports Google Chat basic formatting (*bold*, _italic_).' },
        thread: { type: 'string', description: 'Optional thread resource name (spaces/X/threads/Z) to reply within.' },
      },
      required: ['space', 'text'],
    },
  },
];

// ---- tool implementations --------------------------------------------------

async function runTool(name, args) {
  args = args || {};
  switch (name) {
    case 'list_spaces': {
      let spaces = await listAllSpaces();
      if (args.filter) {
        const f = String(args.filter).toLowerCase();
        spaces = spaces.filter(s => (s.displayName || '').toLowerCase().includes(f));
      }
      if (!spaces.length) return 'No spaces found.';
      return `${spaces.length} space(s):\n` + spaces.map(spaceLabel).join('\n');
    }

    case 'list_messages': {
      const parent = await resolveSpace(args.space);
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
      const { data } = await chatClient.spaces.messages.list({
        parent, pageSize: limit, orderBy: 'createTime desc',
      });
      const msgs = data.messages || [];
      if (!msgs.length) return `No messages in ${parent}.`;
      return `${msgs.length} message(s) in ${parent} (newest first):\n\n` + msgs.map(fmtMessage).join('\n\n');
    }

    case 'get_message': {
      if (!args.name) throw new Error('A message "name" (spaces/X/messages/Y) is required.');
      const { data } = await chatClient.spaces.messages.get({ name: args.name });
      return fmtMessage(data);
    }

    case 'search_messages': {
      if (!args.query) throw new Error('A "query" is required.');
      const q = String(args.query).toLowerCase();
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      let targets;
      if (args.space) {
        targets = [await resolveSpace(args.space)];
      } else {
        targets = (await listAllSpaces()).slice(0, 15).map(s => s.name);
      }
      const matches = [];
      for (const parent of targets) {
        if (matches.length >= limit) break;
        try {
          const { data } = await chatClient.spaces.messages.list({
            parent, pageSize: 75, orderBy: 'createTime desc',
          });
          for (const m of data.messages || []) {
            if ((m.text || '').toLowerCase().includes(q)) {
              matches.push(m);
              if (matches.length >= limit) break;
            }
          }
        } catch (e) { /* skip spaces we can't read */ }
      }
      matches.sort((a, b) => String(b.createTime).localeCompare(String(a.createTime)));
      if (!matches.length) return `No recent messages matched "${args.query}".`;
      return `${matches.length} match(es) for "${args.query}":\n\n` + matches.map(fmtMessage).join('\n\n');
    }

    case 'send_message': {
      const parent = await resolveSpace(args.space);
      if (!args.text) throw new Error('A "text" is required.');
      const requestBody = { text: String(args.text) };
      const params = { parent, requestBody };
      if (args.thread) {
        requestBody.thread = { name: args.thread };
        params.messageReplyOption = 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
      }
      const { data } = await chatClient.spaces.messages.create(params);
      return `Sent to ${parent}.\nMessage id: ${data.name}\nThread: ${data.thread && data.thread.name}`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---- JSON-RPC / MCP transport ----------------------------------------------

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handleRpc(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    const protocolVersion = (params && params.protocolVersion) || DEFAULT_PROTOCOL;
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') return rpcResult(id, {});

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const text = await runTool(toolName, args);
      return rpcResult(id, { content: [{ type: 'text', text }], isError: false });
    } catch (e) {
      const detail = (e && e.errors && e.errors[0] && e.errors[0].message) || (e && e.message) || String(e);
      return rpcResult(id, { content: [{ type: 'text', text: `Error: ${detail}` }], isError: true });
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

// Mounts the connector on the given Express app.
function mountChatMcp(app) {
  if (!chatEnabled) {
    console.log('[mcp-chat] disabled — set CHAT_MCP_TOKEN, CHAT_REFRESH_TOKEN, CHAT_CLIENT_ID/SECRET to enable.');
    return;
  }

  // Streamable HTTP: clients POST JSON-RPC here. The secret token in the path
  // is the access gate (the connector UI only accepts a URL).
  // Streamable HTTP: clients POST JSON-RPC here. Per the MCP spec, when the
  // client's Accept header allows text/event-stream we reply as a (single-shot)
  // SSE stream; otherwise we reply with plain JSON. Both are spec-compliant, but
  // Claude's connector expects the SSE form, so we honor whatever it asks for.
  app.post('/mcp/:token', async (req, res) => {
    if (req.params.token !== MCP_TOKEN) return res.status(404).end();

    const body = req.body;
    const wantsSse = String(req.headers.accept || '').includes('text/event-stream');

    // Notifications / responses (no id) — e.g. notifications/initialized — get a bare 202.
    if (body && body.method && body.id === undefined) {
      return res.status(202).end();
    }
    if (!body || body.jsonrpc !== '2.0' || !body.method) {
      return res.status(400).json(rpcError(body && body.id, -32600, 'Invalid Request'));
    }

    // Assign/echo a session id (Claude tracks the connection by it).
    const sessionId = req.headers['mcp-session-id'] || crypto.randomUUID();

    try {
      const response = await handleRpc(body);
      if (wantsSse) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'Mcp-Session-Id': sessionId,
        });
        res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        return res.end();
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Mcp-Session-Id', sessionId);
      return res.json(response);
    } catch (e) {
      return res.status(500).json(rpcError(body.id, -32603, e.message || 'Internal error'));
    }
  });

  // GET opens the server→client SSE stream the client listens on. We don't push
  // anything, but the stream must stay open (with keep-alives) or clients hang.
  app.get('/mcp/:token', (req, res) => {
    if (req.params.token !== MCP_TOKEN) return res.status(404).end();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Mcp-Session-Id': req.headers['mcp-session-id'] || crypto.randomUUID(),
    });
    res.write(': connected\n\n');
    const keepAlive = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch (_) {} }, 15000);
    req.on('close', () => clearInterval(keepAlive));
  });

  // Session teardown — Claude may DELETE when disconnecting.
  app.delete('/mcp/:token', (req, res) => {
    if (req.params.token !== MCP_TOKEN) return res.status(404).end();
    res.status(200).end();
  });

  console.log('[mcp-chat] enabled — connector live at /mcp/<CHAT_MCP_TOKEN>');
}

module.exports = { mountChatMcp };
