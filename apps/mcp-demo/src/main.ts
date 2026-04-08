import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';

type Task = { id: string; title: string; completed: boolean };
type SessionContext = {
  server: Server;
  transport: StreamableHTTPServerTransport;
};

const tasks: Task[] = [
  { id: '1', title: '学习 MCP', completed: false },
  { id: '2', title: '实现 MCP Server', completed: false },
];

const sessions = new Map<string, SessionContext>();

function snapshotTasks(): Task[] {
  return tasks.map((task) => ({ ...task }));
}

function nextTaskId(): string {
  const nextId = tasks.reduce((maxId, task) => {
    const numericId = Number(task.id);
    return Number.isFinite(numericId) ? Math.max(maxId, numericId) : maxId;
  }, 0);
  return String(nextId + 1);
}

function addTask(title: string): Task {
  const newTask: Task = {
    id: nextTaskId(),
    title,
    completed: false,
  };
  tasks.push(newTask);
  return newTask;
}

function completeTask(taskId: string): Task | undefined {
  const task = tasks.find((item) => item.id === taskId);
  if (task) {
    task.completed = true;
  }
  return task;
}

function createServer(): Server {
  const server = new Server(
    { name: 'mcp-demo', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'list_tasks',
          description: '获取所有任务列表',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'add_task',
          description: '添加新任务',
          inputSchema: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '任务标题' },
            },
            required: ['title'],
          },
        },
        {
          name: 'complete_task',
          description: '完成任务',
          inputSchema: {
            type: 'object',
            properties: {
              taskId: { type: 'string', description: '任务ID' },
            },
            required: ['taskId'],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const input = (args ?? {}) as Record<string, unknown>;

    switch (name) {
      case 'list_tasks':
        return {
          content: [{ type: 'text', text: JSON.stringify(snapshotTasks(), null, 2) }],
        };

      case 'add_task': {
        const title = typeof input.title === 'string' ? input.title : '';
        const newTask = addTask(title);
        return {
          content: [{ type: 'text', text: `任务已添加: ${newTask.title} (ID: ${newTask.id})` }],
        };
      }

      case 'complete_task': {
        const taskId = typeof input.taskId === 'string' ? input.taskId : '';
        const task = completeTask(taskId);
        if (!task) {
          return {
            content: [{ type: 'text', text: `未找到任务: ${taskId}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: `任务已完成: ${task.title}` }],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `未知工具: ${name}` }],
          isError: true,
        };
    }
  });

  return server;
}

function getPort(): number {
  const rawPort = process.env.BOUNDLESS_APP_PORT ?? process.env.PORT ?? '3000';
  const parsed = Number(rawPort);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
}

function getSessionId(headers: Record<string, unknown>): string | undefined {
  const value = headers['mcp-session-id'];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) {
    return value[0];
  }
  return undefined;
}

function createSessionContext(): SessionContext {
  const server = createServer();
  let context!: SessionContext;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, context);
    },
  });
  context = { server, transport };

  transport.onclose = () => {
    const sessionId = transport.sessionId;
    if (sessionId) {
      sessions.delete(sessionId);
    }
  };

  transport.onerror = (error) => {
    console.error('[mcp-demo] MCP transport error:', error);
  };

  return { server, transport };
}

async function handleMcpRequest(req: any, res: any): Promise<void> {
  const sessionId = getSessionId(req.headers as Record<string, unknown>);
  const existingSession = sessionId ? sessions.get(sessionId) : undefined;

  if (existingSession) {
    await existingSession.transport.handleRequest(req, res, req.body);
    return;
  }

  if (req.method === 'POST' && !sessionId && isInitializeRequest(req.body)) {
    const context = createSessionContext();

    await context.server.connect(context.transport);
    await context.transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'Bad Request: No valid session ID provided',
    },
    id: null,
  });
}

async function main() {
  const app = createMcpExpressApp();
  const port = getPort();

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, last-event-id');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      app: 'mcp-demo',
      tasks: tasks.length,
    });
  });

  app.get('/api/tasks', (_req, res) => {
    res.json({
      tasks: snapshotTasks(),
    });
  });

  app.post('/mcp', async (req, res) => {
    await handleMcpRequest(req, res);
  });

  app.get('/mcp', async (req, res) => {
    await handleMcpRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    await handleMcpRequest(req, res);
  });

  const server = app.listen(port, '127.0.0.1', () => {
    console.error(`[mcp-demo] listening on http://127.0.0.1:${port}`);
  });

  const shutdown = async () => {
    for (const session of sessions.values()) {
      await session.transport.close().catch(() => undefined);
      await session.server.close().catch(() => undefined);
    }
    sessions.clear();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });
}

main().catch((error) => {
  console.error('[mcp-demo] fatal error:', error);
  process.exit(1);
});
