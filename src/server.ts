import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { BrowserSession } from './browser/session.js';
import type { Config } from './config.js';
import { ToolError } from './errors.js';
import type { Logger } from './logging.js';
import { resources } from './resources.js';
import { selectTools } from './tools/index.js';
import type { ToolContext } from './tools/types.js';

const SERVER_NAME = 'gm-puppeteer';
const SERVER_VERSION = '0.1.0-dev';

export function createServer(browser: BrowserSession, log: Logger, config: Config): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  const ctx: ToolContext = { browser, log };
  const activeTools = selectTools(config);
  const toolsByName = new Map(activeTools.map((t) => [t.name, t]));
  const resourcesByUri = new Map(resources.map((r) => [r.uri, r]));
  log.info(
    { allowEval: config.allowEval, toolCount: activeTools.length, resourceCount: resources.length },
    'registry built',
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: activeTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema, { target: 'jsonSchema7' }) as Record<
        string,
        unknown
      >,
    })),
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const resource = resourcesByUri.get(req.params.uri);
    if (!resource) {
      throw new ToolError('INVALID_INPUT', `Unknown resource: ${req.params.uri}`);
    }
    return {
      contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = toolsByName.get(req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              code: 'INVALID_INPUT',
              message: `Unknown tool: ${req.params.name}`,
            }),
          },
        ],
      };
    }

    const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              code: 'INVALID_INPUT',
              message: 'Input validation failed',
              details: parsed.error.issues,
            }),
          },
        ],
      };
    }

    try {
      const content = await tool.handler(parsed.data, ctx);
      return { content };
    } catch (err) {
      const payload =
        err instanceof ToolError
          ? err.toJSON()
          : {
              code: 'INTERNAL' as const,
              message: err instanceof Error ? err.message : String(err),
            };
      log.error({ tool: tool.name, err: payload }, 'tool handler failed');
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      };
    }
  });

  return server;
}

export async function runStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
