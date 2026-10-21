import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

declare global {
  interface Env {
    OAUTH_PROVIDER: OAuthHelpers;
    SESSION_SECRET?: string;
  }

  namespace Cloudflare {
    interface Env {
      OAUTH_PROVIDER: OAuthHelpers;
      SESSION_SECRET?: string;
    }
  }
}

export {};
