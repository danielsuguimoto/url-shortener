export interface Link {
  slug: string;
  url: string;
  createdAt: number;
  updatedAt?: number;
  owner?: string;
}

export interface LinkList {
  links: Link[];
  cursor: string | null;
}

interface LinkMetadata {
  createdAt: number;
  updatedAt?: number;
  owner?: string;
  url?: string;
}

const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const UNBIASED_BYTE_LIMIT = 256 - (256 % ALPHABET.length);
const RANDOM_SLUG_LENGTH = 7;
const MAX_URL_LENGTH = 2048;
const MAX_METADATA_BYTES = 1024;
const encoder = new TextEncoder();
const RESERVED = new Set([
  'api',
  'oauth',
  'mcp',
  'authorize',
  'login',
  'logout',
  'assets',
  'favicon.ico',
]);

export class LinkError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LinkError';
  }
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED.has(slug.toLowerCase());
}

export function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new LinkError(400, 'Slug must be 1-64 characters of letters, digits, "-" or "_"');
  }
  if (isReservedSlug(slug)) {
    throw new LinkError(400, `Slug "${slug}" is reserved`);
  }
}

export function validateDestination(raw: unknown, selfHost: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new LinkError(400, 'url is required');
  }
  if (raw.length > MAX_URL_LENGTH) {
    throw new LinkError(400, `url exceeds ${MAX_URL_LENGTH} characters`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LinkError(400, 'url is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LinkError(400, 'url must use http or https');
  }
  if (url.host === selfHost) {
    throw new LinkError(400, 'url cannot point to this host');
  }
  return raw;
}

export function randomSlug(length = RANDOM_SLUG_LENGTH): string {
  let slug = '';
  while (slug.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < UNBIASED_BYTE_LIMIT && slug.length < length) {
        slug += ALPHABET[byte % ALPHABET.length];
      }
    }
  }
  return slug;
}

function withUrl(metadata: LinkMetadata, url: string): LinkMetadata {
  const full = { ...metadata, url };
  return encoder.encode(JSON.stringify(full)).length <= MAX_METADATA_BYTES ? full : metadata;
}

export async function getLink(kv: KVNamespace, slug: string): Promise<Link | null> {
  const { value, metadata } = await kv.getWithMetadata<LinkMetadata>(slug);
  if (value === null) return null;
  return {
    slug,
    url: value,
    createdAt: metadata?.createdAt ?? 0,
    updatedAt: metadata?.updatedAt,
    owner: metadata?.owner,
  };
}

export async function listLinks(
  kv: KVNamespace,
  limit = 50,
  cursor?: string,
): Promise<LinkList> {
  const page = await kv.list<LinkMetadata>({
    limit: Math.min(Math.max(limit, 1), 100),
    cursor,
  });
  const links = await Promise.all(
    page.keys.map(async (key): Promise<Link | null> => {
      const meta = key.metadata;
      const url = meta?.url ?? (await kv.get(key.name));
      if (url === null) return null;
      return {
        slug: key.name,
        url,
        createdAt: meta?.createdAt ?? 0,
        updatedAt: meta?.updatedAt,
        owner: meta?.owner,
      };
    }),
  );
  return {
    links: links.filter((link): link is Link => link !== null),
    cursor: page.list_complete ? null : (page.cursor ?? null),
  };
}

export async function createLink(
  kv: KVNamespace,
  url: unknown,
  slug: string | undefined,
  selfHost: string,
  owner?: string,
): Promise<Link> {
  const destination = validateDestination(url, selfHost);
  if (slug !== undefined) {
    validateSlug(slug);
    if ((await kv.get(slug)) !== null) {
      throw new LinkError(409, `Slug "${slug}" is already taken`);
    }
    const createdAt = Date.now();
    await kv.put(slug, destination, { metadata: withUrl({ createdAt, owner }, destination) });
    return { slug, url: destination, createdAt, owner };
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const generated = randomSlug();
    if ((await kv.get(generated)) === null) {
      const createdAt = Date.now();
      await kv.put(generated, destination, {
        metadata: withUrl({ createdAt, owner }, destination),
      });
      return { slug: generated, url: destination, createdAt, owner };
    }
  }
  throw new LinkError(500, 'Could not allocate a unique slug');
}

export async function updateLink(
  kv: KVNamespace,
  slug: string,
  url: unknown,
  selfHost: string,
): Promise<Link> {
  const destination = validateDestination(url, selfHost);
  const existing = await getLink(kv, slug);
  if (!existing) throw new LinkError(404, `Slug "${slug}" not found`);
  const updatedAt = Date.now();
  await kv.put(slug, destination, {
    metadata: withUrl(
      { createdAt: existing.createdAt, updatedAt, owner: existing.owner },
      destination,
    ),
  });
  return { ...existing, url: destination, updatedAt };
}

export async function deleteLink(kv: KVNamespace, slug: string): Promise<boolean> {
  if ((await kv.get(slug)) === null) return false;
  await kv.delete(slug);
  return true;
}
