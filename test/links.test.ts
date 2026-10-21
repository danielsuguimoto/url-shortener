import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  LinkError,
  createLink,
  deleteLink,
  getLink,
  listLinks,
  randomSlug,
  updateLink,
  validateDestination,
  validateSlug,
} from '../src/links';

const HOST = 'short.example.com';

describe('validateDestination', () => {
  it('accepts http and https URLs', () => {
    expect(validateDestination('https://example.com/x?y=1', HOST)).toBe('https://example.com/x?y=1');
    expect(validateDestination('http://example.com', HOST)).toBe('http://example.com');
  });

  it('rejects non-URL input', () => {
    expect(() => validateDestination('not a url', HOST)).toThrow(LinkError);
    expect(() => validateDestination('', HOST)).toThrow(LinkError);
    expect(() => validateDestination(undefined, HOST)).toThrow(LinkError);
  });

  it('rejects non-http protocols', () => {
    expect(() => validateDestination('javascript:alert(1)', HOST)).toThrow(LinkError);
    expect(() => validateDestination('ftp://example.com', HOST)).toThrow(LinkError);
    expect(() => validateDestination('data:text/plain,hi', HOST)).toThrow(LinkError);
  });

  it('rejects self-referencing URLs', () => {
    expect(() => validateDestination(`https://${HOST}/abc`, HOST)).toThrow(LinkError);
  });

  it('rejects overlong URLs', () => {
    expect(() => validateDestination(`https://example.com/${'a'.repeat(2100)}`, HOST)).toThrow(
      LinkError,
    );
  });
});

describe('validateSlug', () => {
  it('accepts valid slugs', () => {
    expect(() => validateSlug('a')).not.toThrow();
    expect(() => validateSlug('my-link_2')).not.toThrow();
  });

  it('rejects invalid slugs', () => {
    expect(() => validateSlug('')).toThrow(LinkError);
    expect(() => validateSlug('has space')).toThrow(LinkError);
    expect(() => validateSlug('dots.bad')).toThrow(LinkError);
    expect(() => validateSlug('slash/bad')).toThrow(LinkError);
    expect(() => validateSlug('x'.repeat(65))).toThrow(LinkError);
  });

  it('rejects reserved names', () => {
    expect(() => validateSlug('api')).toThrow(LinkError);
    expect(() => validateSlug('mcp')).toThrow(LinkError);
    expect(() => validateSlug('oauth')).toThrow(LinkError);
  });
});

describe('link store', () => {
  it('creates a link with a custom slug', async () => {
    const link = await createLink(env.LINKS, 'https://example.com', 'docs', HOST, 'admin');
    expect(link.slug).toBe('docs');
    expect(link.owner).toBe('admin');
    expect(await env.LINKS.get('docs')).toBe('https://example.com');
  });

  it('creates a link with a random slug', async () => {
    const link = await createLink(env.LINKS, 'https://example.com', undefined, HOST);
    expect(link.slug).toMatch(/^[A-Za-z0-9]{7}$/);
    expect((await getLink(env.LINKS, link.slug))?.url).toBe('https://example.com');
  });

  it('rejects a duplicate custom slug', async () => {
    await createLink(env.LINKS, 'https://a.example.com', 'taken', HOST);
    await expect(createLink(env.LINKS, 'https://b.example.com', 'taken', HOST)).rejects.toMatchObject(
      { status: 409 },
    );
  });

  it('gets, updates, and deletes a link', async () => {
    await createLink(env.LINKS, 'https://old.example.com', 'crud', HOST);
    const updated = await updateLink(env.LINKS, 'crud', 'https://new.example.com', HOST);
    expect(updated.url).toBe('https://new.example.com');
    expect(updated.updatedAt).toBeGreaterThan(0);
    expect(await deleteLink(env.LINKS, 'crud')).toBe(true);
    expect(await getLink(env.LINKS, 'crud')).toBeNull();
    expect(await deleteLink(env.LINKS, 'crud')).toBe(false);
  });

  it('returns 404 when updating a missing slug', async () => {
    await expect(updateLink(env.LINKS, 'ghost', 'https://x.com', HOST)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('lists links with metadata', async () => {
    await createLink(env.LINKS, 'https://one.example.com', 'l-one', HOST, 'admin');
    await createLink(env.LINKS, 'https://two.example.com', 'l-two', HOST, 'admin');
    const page = await listLinks(env.LINKS, 10);
    const slugs = page.links.map((link) => link.slug);
    expect(slugs).toContain('l-one');
    expect(slugs).toContain('l-two');
    const one = page.links.find((link) => link.slug === 'l-one');
    expect(one?.url).toBe('https://one.example.com');
    expect(one?.createdAt).toBeGreaterThan(0);
  });

  it('mirrors short URLs into metadata and falls back for long ones', async () => {
    const longUrl = `https://example.com/${'a'.repeat(1500)}`;
    await createLink(env.LINKS, 'https://brief.example.com/x', 'meta-short', HOST);
    await createLink(env.LINKS, longUrl, 'meta-long', HOST);
    const shortMeta = await env.LINKS.getWithMetadata<{ url?: string }>('meta-short');
    const longMeta = await env.LINKS.getWithMetadata<{ url?: string }>('meta-long');
    expect(shortMeta.metadata?.url).toBe('https://brief.example.com/x');
    expect(longMeta.metadata?.url).toBeUndefined();
    const page = await listLinks(env.LINKS, 100);
    expect(page.links.find((link) => link.slug === 'meta-long')?.url).toBe(longUrl);
  });

  it('keeps the metadata URL in sync on update', async () => {
    await createLink(env.LINKS, 'https://before.example.com', 'meta-upd', HOST);
    await updateLink(env.LINKS, 'meta-upd', 'https://after.example.com', HOST);
    const page = await listLinks(env.LINKS, 100);
    expect(page.links.find((link) => link.slug === 'meta-upd')?.url).toBe(
      'https://after.example.com',
    );
  });
});

describe('randomSlug', () => {
  it('generates URL-safe slugs', () => {
    for (let index = 0; index < 20; index++) {
      expect(randomSlug()).toMatch(/^[A-Za-z0-9]{7}$/);
    }
  });
});
