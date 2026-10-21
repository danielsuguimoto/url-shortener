import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { apiHandler } from '../src/mcp';

const ORIGIN = 'https://short.test';

async function callTool(name: string, args: Record<string, unknown>) {
  const ctx = createExecutionContext();
  const request = new Request(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const response = await apiHandler.fetch(request as unknown as Request, env, ctx);
  const raw = await response.text();
  const json = raw.startsWith('event:')
    ? JSON.parse(raw.split('\n').find((line) => line.startsWith('data:'))!.slice(5))
    : JSON.parse(raw);
  return { status: response.status, body: json };
}

describe('mcp tools', () => {
  it('creates and resolves a short link', async () => {
    const { status, body } = await callTool('create_short_link', {
      url: 'https://example.com/mcp',
      slug: 'mcp-test',
    });
    expect(status).toBe(200);
    const result = JSON.parse(body.result.content[0].text);
    expect(result.slug).toBe('mcp-test');
    expect(result.short_url).toBe(`${ORIGIN}/mcp-test`);
    expect(await env.LINKS.get('mcp-test')).toBe('https://example.com/mcp');
  });

  it('gets a link', async () => {
    await env.LINKS.put('mcp-get', 'https://example.com/get');
    const { body } = await callTool('get_link', { slug: 'mcp-get' });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.url).toBe('https://example.com/get');
  });

  it('updates a link', async () => {
    await env.LINKS.put('mcp-upd', 'https://example.com/old');
    const { body } = await callTool('update_link', {
      slug: 'mcp-upd',
      url: 'https://example.com/new',
    });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.url).toBe('https://example.com/new');
    expect(await env.LINKS.get('mcp-upd')).toBe('https://example.com/new');
  });

  it('deletes a link', async () => {
    await env.LINKS.put('mcp-del', 'https://example.com/del');
    const { body } = await callTool('delete_link', { slug: 'mcp-del' });
    const result = JSON.parse(body.result.content[0].text);
    expect(result.deleted).toBe(true);
    expect(await env.LINKS.get('mcp-del')).toBeNull();
  });

  it('returns an error for a missing slug', async () => {
    const { body } = await callTool('get_link', { slug: 'nope-nope' });
    expect(body.result.isError).toBe(true);
  });

  it('lists links', async () => {
    await env.LINKS.put('mcp-list', 'https://example.com/list');
    const { body } = await callTool('list_links', {});
    const result = JSON.parse(body.result.content[0].text);
    const slugs = result.links.map((link: { slug: string }) => link.slug);
    expect(slugs).toContain('mcp-list');
  });
});
