import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { LinkError, createLink, deleteLink, getLink, listLinks, updateLink } from './links';

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function failure(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true as const };
}

function toolCall<T>(run: () => Promise<T>) {
  return run()
    .then((result) => text(result))
    .catch((error: unknown) => {
      if (error instanceof LinkError) return failure(error.message);
      console.error('MCP tool failed', error);
      return failure('Internal error');
    });
}

const slugParam = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'slug must be 1-64 chars of letters, digits, - or _');

export function buildServer(env: Env, origin: string, owner: string): McpServer {
  const server = new McpServer({ name: 'url-shortener', version: '1.0.0' });
  const shortUrl = (slug: string) => `${origin}/${slug}`;

  server.registerTool(
    'create_short_link',
    {
      description: 'Create a short link to a destination URL. Returns the short URL.',
      inputSchema: {
        url: z.url().describe('Destination URL (http or https)'),
        slug: slugParam.optional().describe('Custom slug; a random one is generated when omitted'),
      },
    },
    ({ url, slug }) =>
      toolCall(async () => {
        const link = await createLink(env.LINKS, url, slug, new URL(origin).host, owner);
        return { ...link, short_url: shortUrl(link.slug) };
      }),
  );

  server.registerTool(
    'list_links',
    {
      description: 'List short links in alphabetical slug order, paginated by cursor.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Max links to return (default 50)'),
        cursor: z.string().optional().describe('Pagination cursor from a previous call'),
      },
    },
    ({ limit, cursor }) =>
      toolCall(async () => {
        const page = await listLinks(env.LINKS, limit ?? 50, cursor);
        return {
          links: page.links.map((link) => ({ ...link, short_url: shortUrl(link.slug) })),
          cursor: page.cursor,
        };
      }),
  );

  server.registerTool(
    'get_link',
    {
      description: 'Get a short link by slug.',
      inputSchema: { slug: slugParam },
    },
    ({ slug }) =>
      toolCall(async () => {
        const link = await getLink(env.LINKS, slug);
        if (!link) throw new LinkError(404, `Slug "${slug}" not found`);
        return { ...link, short_url: shortUrl(slug) };
      }),
  );

  server.registerTool(
    'update_link',
    {
      description: 'Point an existing short link at a new destination URL.',
      inputSchema: {
        slug: slugParam,
        url: z.url().describe('New destination URL (http or https)'),
      },
    },
    ({ slug, url }) =>
      toolCall(async () => {
        const link = await updateLink(env.LINKS, slug, url, new URL(origin).host);
        return { ...link, short_url: shortUrl(slug) };
      }),
  );

  server.registerTool(
    'delete_link',
    {
      description: 'Delete a short link by slug.',
      inputSchema: { slug: slugParam },
    },
    ({ slug }) =>
      toolCall(async () => {
        if (!(await deleteLink(env.LINKS, slug))) {
          throw new LinkError(404, `Slug "${slug}" not found`);
        }
        return { deleted: true, slug };
      }),
  );

  return server;
}

export const apiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = new URL(request.url).origin;
    const props = ctx.props as { userId?: unknown } | undefined;
    const owner = typeof props?.userId === 'string' ? props.userId : 'admin';
    return createMcpHandler(() => buildServer(env, origin, owner), {
      route: '/mcp',
      authContext: { props: props ?? {} },
    })(request, env, ctx);
  },
};
