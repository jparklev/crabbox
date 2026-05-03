import { authenticateRequest, requestWithAuthContext, type AuthContext } from "./auth";
import { FleetDurableObject } from "./fleet";
import { json } from "./http";
import { credentialPayer, parsePaymentCredential, paymentConfigured } from "./payments";
import type { Env } from "./types";

const mppLeaseRoute = /^\/v1\/leases(?:$|\/[^/]+\/(?:heartbeat|release|resume)$)/;

export { FleetDurableObject };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/health") {
      return json({ ok: true, service: "crabbox-coordinator" });
    }
    if (url.pathname.startsWith("/v1/auth/")) {
      const id = env.FLEET.idFromName("default");
      return env.FLEET.get(id).fetch(request);
    }
    const auth = await authenticateRequest(request, env);
    const fleetID = env.FLEET.idFromName("default");
    if (auth?.authorized) {
      const upgraded = upgradeAuthWithPayer(request, auth);
      return env.FLEET.get(fleetID).fetch(requestWithAuthContext(request, upgraded));
    }
    if (mppEligible(request, url, env)) {
      const ctx = mppAuth(request, env);
      return env.FLEET.get(fleetID).fetch(requestWithAuthContext(request, ctx));
    }
    return json({ error: "unauthorized" }, { status: 401 });
  },
};

function upgradeAuthWithPayer(request: Request, auth: AuthContext): AuthContext {
  const payer = extractCredentialPayer(request);
  if (!payer || auth.payer === payer) {
    return auth;
  }
  return { ...auth, payer };
}

function mppEligible(request: Request, url: URL, env: Env): boolean {
  return request.method === "POST" && mppLeaseRoute.test(url.pathname) && paymentConfigured(env);
}

function mppAuth(request: Request, env: Env): AuthContext {
  const payer = extractCredentialPayer(request)?.toLowerCase();
  // For MPP-only flows the agent has no signed user identity. We accept the
  // payer wallet itself as the canonical owner, prefixed with `mpp:` so it
  // can never collide with a real email or login. The wallet is also exposed
  // via `payer` so cost-limits/audit can index on the funding source even if
  // the owner later upgrades to a GitHub identity.
  const owner = payer
    ? `mpp:${payer}`
    : `mpp:${env.CRABBOX_MPP_RECIPIENT?.toLowerCase() ?? "anonymous"}`;
  const ctx: AuthContext = {
    authorized: true,
    admin: false,
    auth: "mpp",
    owner,
    org: env.CRABBOX_DEFAULT_ORG ?? "mpp",
  };
  if (payer) {
    ctx.payer = payer;
  }
  return ctx;
}

export function extractCredentialPayer(request: Request): string | undefined {
  return credentialPayer(parsePaymentCredential(request));
}

export async function isAuthorized(
  request: Request,
  env: Pick<
    Env,
    | "CRABBOX_SHARED_TOKEN"
    | "CRABBOX_ADMIN_TOKEN"
    | "CRABBOX_SESSION_SECRET"
    | "CRABBOX_DEFAULT_ORG"
    | "CRABBOX_ACCESS_TEAM_DOMAIN"
    | "CRABBOX_ACCESS_AUD"
  >,
): Promise<boolean> {
  return Boolean((await authenticateRequest(request, env))?.authorized);
}
