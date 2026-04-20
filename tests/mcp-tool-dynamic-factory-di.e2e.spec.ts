import {
  INestApplication,
  Inject,
  Injectable,
  Scope,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { z } from 'zod';
import { Tool, ToolFactoryContext } from '../src';
import { McpModule } from '../src/mcp/mcp.module';
import { createStreamableClient } from './utils';

/**
 * Plain singleton service the factory will look up at request time via
 * `ctx.resolve(...)`. The test asserts that overriding this service with
 * `Test.overrideProvider(...)` causes the factory to observe the override —
 * proving the DI hook actually goes through Nest, not through a captured
 * module-scoped reference.
 */
@Injectable()
export class SkillsService {
  async getAvailableSkills(): Promise<string[]> {
    return ['default-skill-a', 'default-skill-b'];
  }
}

/**
 * Request-scoped service that reads from the current REQUEST. Used to
 * prove that when the factory resolves it, the resolution honors the
 * per-request contextId so the service sees the *current* MCP request,
 * not a stale one.
 */
@Injectable({ scope: Scope.REQUEST })
export class RequestEcho {
  constructor(@Inject(REQUEST) private readonly req: any) {}

  getHeader(name: string): string | undefined {
    return this.req?.headers?.[name];
  }
}

@Injectable()
export class DiAwareTool {
  @Tool('skills-aware', async (
    _request: unknown,
    ctx?: ToolFactoryContext,
  ) => {
    if (!ctx) {
      throw new Error('ToolFactoryContext was not provided');
    }
    const skills = await ctx.resolve(SkillsService);
    const list = await skills.getAvailableSkills();

    return {
      description: `Available skills: ${list.join(', ')}`,
      parameters: z.object({
        skill: z.enum(list as [string, ...string[]]),
      }),
    };
  })
  async run({ skill }: { skill: string }) {
    return { content: [{ type: 'text', text: `picked=${skill}` }] };
  }
}

@Injectable()
export class RequestScopedAwareTool {
  @Tool('request-scoped-aware', async (
    _request: unknown,
    ctx?: ToolFactoryContext,
  ) => {
    if (!ctx) {
      throw new Error('ToolFactoryContext was not provided');
    }
    const echo = await ctx.resolve(RequestEcho);
    const tag = echo.getHeader('x-tag') ?? 'no-tag';
    return {
      description: `tag=${tag}`,
      parameters: z.object({}),
    };
  })
  async run() {
    return { content: [{ type: 'text', text: 'ok' }] };
  }
}

/** Factory that ignores the new ctx — proves backward compat is preserved. */
@Injectable()
export class LegacySingleArgTool {
  @Tool('legacy-single-arg', (request: any) => ({
    description: `legacy ${request?.headers?.['x-legacy'] ?? 'none'}`,
    parameters: z.object({}),
  }))
  async run() {
    return { content: [{ type: 'text', text: 'ok' }] };
  }
}

async function buildApp(opts?: {
  override?: { provide: any; useValue: any };
}): Promise<{ app: INestApplication; port: number }> {
  const builder = Test.createTestingModule({
    imports: [
      McpModule.forRoot({
        name: 'test-dynamic-factory-di-server',
        version: '0.0.1',
        guards: [],
        streamableHttp: {
          enableJsonResponse: true,
          sessionIdGenerator: undefined,
          statelessMode: true,
        },
      }),
    ],
    providers: [
      SkillsService,
      RequestEcho,
      DiAwareTool,
      RequestScopedAwareTool,
      LegacySingleArgTool,
    ],
  });

  if (opts?.override) {
    builder.overrideProvider(opts.override.provide).useValue(opts.override.useValue);
  }

  const moduleFixture: TestingModule = await builder.compile();
  const app = moduleFixture.createNestApplication();
  await app.listen(0);
  const port = (app.getHttpServer().address() as import('net').AddressInfo).port;
  return { app, port };
}

describe('E2E: MCP Tool dynamic factory DI context', () => {
  it('factory resolves the real provider via ctx.resolve and reflects its data in tools/list', async () => {
    const { app, port } = await buildApp();
    try {
      const client = await createStreamableClient(port);
      try {
        const tools = await client.listTools();
        const tool = tools.tools.find((t) => t.name === 'skills-aware');
        expect(tool).toBeDefined();
        expect(tool!.description).toBe(
          'Available skills: default-skill-a, default-skill-b',
        );
        const enumValues = (tool!.inputSchema as any)?.properties?.skill?.enum;
        expect(enumValues).toEqual(['default-skill-a', 'default-skill-b']);
      } finally {
        await client.close();
      }
    } finally {
      await app.close();
    }
  });

  it('Test.overrideProvider() is observed by the factory', async () => {
    const stub: SkillsService = {
      getAvailableSkills: async () => ['stub-skill'],
    } as any;

    const { app, port } = await buildApp({
      override: { provide: SkillsService, useValue: stub },
    });
    try {
      const client = await createStreamableClient(port);
      try {
        const tools = await client.listTools();
        const tool = tools.tools.find((t) => t.name === 'skills-aware');
        expect(tool).toBeDefined();
        expect(tool!.description).toBe('Available skills: stub-skill');
        const enumValues = (tool!.inputSchema as any)?.properties?.skill?.enum;
        expect(enumValues).toEqual(['stub-skill']);
      } finally {
        await client.close();
      }
    } finally {
      await app.close();
    }
  });

  it('ctx.resolve honors request scope: factory sees the current MCP request', async () => {
    const { app, port } = await buildApp();
    try {
      const a = await createStreamableClient(port, {
        requestInit: { headers: { 'x-tag': 'alpha' } },
      });
      const b = await createStreamableClient(port, {
        requestInit: { headers: { 'x-tag': 'beta' } },
      });
      try {
        const aTools = await a.listTools();
        const bTools = await b.listTools();
        expect(
          aTools.tools.find((t) => t.name === 'request-scoped-aware')!
            .description,
        ).toBe('tag=alpha');
        expect(
          bTools.tools.find((t) => t.name === 'request-scoped-aware')!
            .description,
        ).toBe('tag=beta');
      } finally {
        await a.close();
        await b.close();
      }
    } finally {
      await app.close();
    }
  });

  it('legacy single-arg factories continue to work unchanged', async () => {
    const { app, port } = await buildApp();
    try {
      const client = await createStreamableClient(port, {
        requestInit: { headers: { 'x-legacy': 'still-here' } },
      });
      try {
        const tools = await client.listTools();
        const tool = tools.tools.find((t) => t.name === 'legacy-single-arg');
        expect(tool).toBeDefined();
        expect(tool!.description).toBe('legacy still-here');
      } finally {
        await client.close();
      }
    } finally {
      await app.close();
    }
  });
});
