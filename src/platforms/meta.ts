import { config, redirectUri } from "../config.ts";
import { requestJson } from "../http.ts";
import type { Platform } from "../types.ts";

// Facebook Login for Business serves both Facebook Pages and the Instagram accounts linked to them.
// (Instagram's own "Instagram Login" can't take direct byte uploads, only public video URLs.)
export const graph = () => `https://graph.facebook.com/${config.graphVersion}`;
const creds = () => config.credentials.facebook;

export function metaAuthorizeUrl(platform: Platform, state: string, scopes: string[]) {
  const q = new URLSearchParams({
    client_id: creds().id,
    redirect_uri: redirectUri(platform),
    response_type: "code",
    scope: scopes.join(","),
    state,
  });
  return `https://www.facebook.com/${config.graphVersion}/dialog/oauth?${q}`;
}

/**
 * Exchanges the login code and lists the Pages the user granted. Page tokens obtained from a
 * long-lived user token do not expire, so nothing needs refreshing afterwards.
 */
export async function metaPages(platform: Platform, code: string, pageFields: string): Promise<any[]> {
  const short = await requestJson(
    `${graph()}/oauth/access_token?${new URLSearchParams({
      client_id: creds().id,
      client_secret: creds().secret,
      redirect_uri: redirectUri(platform),
      code,
    })}`,
  );
  const long = await requestJson(
    `${graph()}/oauth/access_token?${new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: creds().id,
      client_secret: creds().secret,
      fb_exchange_token: short.access_token,
    })}`,
  );
  const pages = await requestJson(
    `${graph()}/me/accounts?${new URLSearchParams({ fields: pageFields, limit: "100", access_token: long.access_token })}`,
  );
  return pages.data ?? [];
}
