import { CanActivate, SetMetadata, Type } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { z } from 'zod';
import { ToolAnnotations as SdkToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { MCP_TOOL_METADATA_KEY } from './constants';

/**
 * Security scheme type for MCP tools
 */
export type SecurityScheme =
  | { type: 'noauth' }
  | { type: 'oauth2'; scopes?: string[] };

export interface ToolMetadata {
  name: string;
  description: string;
  parameters?: z.ZodType;
  outputSchema?: z.ZodType;
  annotations?: SdkToolAnnotations;
  _meta?: Record<string, any>;
  // Security-related metadata
  securitySchemes?: SecurityScheme[];
  isPublic?: boolean;
  requiredScopes?: string[];
  requiredRoles?: string[];
  guards?: Type<CanActivate>[];
  /**
   * Optional dynamic options factory. When present, the tools handler
   * invokes it per-request to resolve description, parameters, outputSchema,
   * annotations and _meta. Set internally by the `@Tool(name, factory)`
   * decorator overload — do not set manually.
   */
  __factory?: ToolOptionsFactory;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ToolAnnotations extends SdkToolAnnotations {}

export interface ToolOptions {
  name?: string;
  description?: string;
  parameters?: z.ZodType;
  outputSchema?: z.ZodType;
  annotations?: ToolAnnotations;
  _meta?: Record<string, any>;
}

/**
 * DI-aware context passed as the optional second argument to a
 * {@link ToolOptionsFactory}.
 *
 * Provides escape hatches for factories that need to read state from
 * NestJS-managed services without resorting to module-scoped singletons.
 * The `resolve` helper honors per-request scope: providers that opt into
 * `Scope.REQUEST` are instantiated against the same `contextId` the rest
 * of the MCP request handler uses, so request-scoped state (e.g.
 * `@Inject(REQUEST)`) sees the current MCP request.
 */
export interface ToolFactoryContext {
  /**
   * Raw HTTP request — same value passed as the first positional argument.
   * Duplicated here so factories can destructure (`(_req, { resolve, request }) => ...`)
   * without referencing the unused first parameter. `undefined` for STDIO.
   */
  request: unknown;
  /**
   * Resolve any provider known to the consuming Nest module by token.
   *
   * Uses `strict: false` so tokens registered in transitively-imported
   * modules are reachable, matching how the tools handler resolves the
   * tool's own host provider for `tools/call`.
   *
   * Tokens may be a class, a string, or a symbol — anything Nest accepts
   * as a provider token.
   */
  resolve: <T>(token: Type<T> | string | symbol) => Promise<T>;
  /**
   * Underlying `ModuleRef`, exposed for advanced cases that `resolve`
   * doesn't cover (e.g. `moduleRef.get(token, { strict: true })`).
   *
   * Note: when calling `moduleRef.resolve` directly, prefer to pass the
   * same `contextId` the MCP handler uses; otherwise request-scoped
   * providers may be instantiated against a different context. The
   * `resolve` helper above already does this correctly.
   */
  moduleRef: ModuleRef;
}

/**
 * Dynamic tool options factory.
 *
 * Receives the underlying HTTP request (or `undefined` for STDIO transport)
 * and a {@link ToolFactoryContext} that exposes per-request DI access.
 * Returns the tool definition. The returned options may omit the `name`
 * field — the static `name` provided to the decorator is always used as
 * the tool identifier for routing.
 *
 * The `ctx` argument is optional in the type signature for backward
 * compatibility: existing single-argument factories continue to work
 * unchanged. Factories that need DI may opt in by accepting a second
 * argument.
 *
 * Factories are invoked at request time both for `tools/list` and
 * `tools/call`. They may be synchronous or asynchronous.
 */
export type ToolOptionsFactory = (
  request: unknown,
  ctx?: ToolFactoryContext,
) => Omit<ToolOptions, 'name'> | Promise<Omit<ToolOptions, 'name'>>;

/**
 * Internal shape stored as decorator metadata when a factory is used.
 *
 * The `name` is captured statically (from the first decorator argument) so
 * that the registry can index the tool deterministically without invoking
 * the factory. The factory is resolved per-request inside the tools handler.
 */
export interface ToolFactoryMetadata {
  name: string;
  __factory: ToolOptionsFactory;
}

export function isToolFactoryMetadata(
  value: unknown,
): value is ToolFactoryMetadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ToolFactoryMetadata).__factory === 'function'
  );
}

/**
 * Decorator that marks a controller method as an MCP tool.
 *
 * Two forms are supported:
 *
 * 1. Static options (the original API):
 *    ```ts
 *    @Tool({ name: 'my-tool', description: '...', parameters: z.object({...}) })
 *    ```
 *
 * 2. Dynamic factory — the tool definition (description, parameters,
 *    outputSchema, annotations, _meta) is resolved per-request from the
 *    HTTP request object. The tool `name` must be provided statically as
 *    the first argument so the registry can route calls without invoking
 *    the factory:
 *    ```ts
 *    @Tool('my-tool', (req) => ({
 *      description: `Hello ${req.user?.name}`,
 *      parameters: z.object({ ... }),
 *    }))
 *    ```
 *    For STDIO transport, the factory receives `undefined`. Factories may
 *    be async and return a `Promise<Omit<ToolOptions, 'name'>>`.
 */
export function Tool(options: ToolOptions): MethodDecorator;
export function Tool(name: string, factory: ToolOptionsFactory): MethodDecorator;
export function Tool(
  optionsOrName: ToolOptions | string,
  factory?: ToolOptionsFactory,
): MethodDecorator {
  if (typeof optionsOrName === 'string') {
    if (typeof factory !== 'function') {
      throw new Error(
        '@Tool(name, factory): factory must be a function returning ToolOptions.',
      );
    }
    const factoryMetadata: ToolFactoryMetadata = {
      name: optionsOrName,
      __factory: factory,
    };
    return SetMetadata(MCP_TOOL_METADATA_KEY, factoryMetadata);
  }

  const options = optionsOrName;
  if (options.parameters === undefined) {
    options.parameters = z.object({});
  }

  return SetMetadata(MCP_TOOL_METADATA_KEY, options);
}
