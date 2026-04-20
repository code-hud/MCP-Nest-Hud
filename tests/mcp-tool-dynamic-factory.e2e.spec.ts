import { INestApplication, Injectable } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { z } from 'zod';
import { Tool } from '../src';
import { McpModule } from '../src/mcp/mcp.module';
import { createStreamableClient } from './utils';

/**
 * Tool whose definition is built per-request from the HTTP request object.
 *
 * - `description` and `parameters` reference values from request headers.
 * - `outputSchema` is set by the factory and used to validate the tool result.
 * - `_meta` and `annotations` are also set per-request to ensure they flow
 *   through to the MCP `tools/list` response.
 */
@Injectable()
export class DynamicGreetingTool {
  @Tool('dynamic-greet', (request: any) => {
    const tenant = (request?.headers?.['x-tenant'] as string) ?? 'default-tenant';
    const allowed = ((request?.headers?.['x-allowed-names'] as string) ?? 'world')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    return {
      description: `Greets a user from tenant ${tenant}`,
      parameters: z.object({
        name: z.enum(allowed as [string, ...string[]]),
      }),
      outputSchema: z.object({
        greeting: z.string(),
        tenant: z.string(),
      }),
      annotations: { title: `Greet (${tenant})`, readOnlyHint: true },
      _meta: { tenant },
    };
  })
  async greet({ name }: { name: string }, _ctx: unknown, request: any) {
    const tenant =
      (request?.headers?.['x-tenant'] as string) ?? 'default-tenant';
    return { greeting: `Hello, ${name}!`, tenant };
  }
}

/** Async-factory variant — verifies `Promise<Omit<ToolOptions, 'name'>>` is awaited. */
@Injectable()
export class AsyncDynamicTool {
  @Tool('async-dynamic', async (request: any) => {
    await new Promise((r) => setTimeout(r, 10));
    const suffix = (request?.headers?.['x-suffix'] as string) ?? 'sync';
    return {
      description: `Async tool (${suffix})`,
      parameters: z.object({ value: z.string() }),
    };
  })
  async run({ value }: { value: string }) {
    return { content: [{ type: 'text', text: `value=${value}` }] };
  }
}

describe('E2E: MCP Tool dynamic factory definition', () => {
  let app: INestApplication;
  let port: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        McpModule.forRoot({
          name: 'test-dynamic-factory-server',
          version: '0.0.1',
          guards: [],
          streamableHttp: {
            enableJsonResponse: true,
            sessionIdGenerator: undefined,
            statelessMode: true,
          },
        }),
      ],
      providers: [DynamicGreetingTool, AsyncDynamicTool],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.listen(0);
    port = (app.getHttpServer().address() as import('net').AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists tools with description and parameters resolved from the request', async () => {
    const client = await createStreamableClient(port, {
      requestInit: {
        headers: {
          'x-tenant': 'acme',
          'x-allowed-names': 'alice,bob',
        },
      },
    });
    try {
      const tools = await client.listTools();
      const tool = tools.tools.find((t) => t.name === 'dynamic-greet');
      expect(tool).toBeDefined();
      expect(tool!.description).toBe('Greets a user from tenant acme');
      expect(tool!.annotations?.title).toBe('Greet (acme)');
      expect(tool!._meta?.tenant).toBe('acme');
      expect(tool!.outputSchema).toBeDefined();
      expect(tool!.outputSchema).toHaveProperty('properties.greeting');
      // The Zod enum should produce JSON Schema with the request-derived values.
      const nameSchema = (tool!.inputSchema as any)?.properties?.name;
      expect(nameSchema).toBeDefined();
      expect(nameSchema.enum).toEqual(['alice', 'bob']);
    } finally {
      await client.close();
    }
  });

  it('produces different tool definitions for different requests', async () => {
    const acme = await createStreamableClient(port, {
      requestInit: { headers: { 'x-tenant': 'acme' } },
    });
    const beta = await createStreamableClient(port, {
      requestInit: { headers: { 'x-tenant': 'beta' } },
    });
    try {
      const a = await acme.listTools();
      const b = await beta.listTools();
      expect(a.tools.find((t) => t.name === 'dynamic-greet')!.description).toBe(
        'Greets a user from tenant acme',
      );
      expect(b.tools.find((t) => t.name === 'dynamic-greet')!.description).toBe(
        'Greets a user from tenant beta',
      );
    } finally {
      await acme.close();
      await beta.close();
    }
  });

  it('validates call arguments against the per-request parameters schema', async () => {
    const client = await createStreamableClient(port, {
      requestInit: {
        headers: { 'x-tenant': 'acme', 'x-allowed-names': 'alice,bob' },
      },
    });
    try {
      const ok: any = await client.callTool({
        name: 'dynamic-greet',
        arguments: { name: 'alice' },
      });
      expect(ok.isError).not.toBe(true);
      expect(ok.structuredContent).toEqual({
        greeting: 'Hello, alice!',
        tenant: 'acme',
      });

      const bad: any = await client.callTool({
        name: 'dynamic-greet',
        arguments: { name: 'eve' },
      });
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toContain('Invalid parameters:');
    } finally {
      await client.close();
    }
  });

  it('supports async factories', async () => {
    const client = await createStreamableClient(port, {
      requestInit: { headers: { 'x-suffix': 'remote' } },
    });
    try {
      const tools = await client.listTools();
      const tool = tools.tools.find((t) => t.name === 'async-dynamic');
      expect(tool).toBeDefined();
      expect(tool!.description).toBe('Async tool (remote)');

      const result: any = await client.callTool({
        name: 'async-dynamic',
        arguments: { value: 'hello' },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toBe('value=hello');
    } finally {
      await client.close();
    }
  });
});
