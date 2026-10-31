import type { OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import app from './app';
import { apiHandler } from './mcp';
import { fetchOAuth } from './oauth';

export function oauthOptions(origin: string): OAuthProviderOptions<Env> {
  return {
    apiRoute: '/mcp',
    apiHandler,
    defaultHandler: app,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: ['links'],
    requiredScopes: ['links'],
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
    },
  };
}

export default {
  fetch(request, env, ctx) {
    return fetchOAuth(request, env, ctx, oauthOptions(new URL(request.url).origin));
  },
} satisfies ExportedHandler<Env>;
