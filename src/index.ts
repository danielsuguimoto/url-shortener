import OAuthProvider from '@cloudflare/workers-oauth-provider';
import app from './app';
import { apiHandler } from './mcp';

export default {
  fetch(request, env, ctx) {
    const origin = new URL(request.url).origin;
    return new OAuthProvider<Env>({
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
    }).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
