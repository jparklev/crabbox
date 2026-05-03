import { describe, expect, it } from "vitest";

import worker, { extractCredentialPayer } from "../src/index";
import type { Env } from "../src/types";

function paymentHeader(credential: {
  source?: string;
  challenge?: unknown;
  payload?: unknown;
}): string {
  const json = JSON.stringify(credential);
  const b64 = Buffer.from(json, "utf-8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `Payment ${b64}`;
}

function fakeEnv(overrides: Partial<Env> = {}): {
  env: Env;
  lastRequest: () => Request | undefined;
} {
  let captured: Request | undefined;
  const fakeStub = {
    fetch: (req: Request) => {
      captured = req;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  };
  const env: Env = {
    FLEET: {
      idFromName: () => ({ toString: () => "default" }),
      get: () => fakeStub,
    } as unknown as DurableObjectNamespace,
    CRABBOX_DEFAULT_ORG: "test-org",
    CRABBOX_SESSION_SECRET: "test-session-secret",
    CRABBOX_MPP_SETTLEMENT_PRIVATE_KEY:
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ...overrides,
  } as Env;
  return { env, lastRequest: () => captured };
}

describe("worker fetch routing", () => {
  it("returns 401 for unauthenticated POST /v1/leases when MPP is not configured", async () => {
    const { env } = fakeEnv();
    const response = await worker.fetch(
      new Request("https://example.test/v1/leases", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("routes unauthenticated POST /v1/leases through DO when MPP is configured", async () => {
    const { env, lastRequest } = fakeEnv({
      CRABBOX_MPP_RECIPIENT: "0x3B098A4Bd4fd4414Be203c39057A82a00CD0d33F",
      CRABBOX_MPP_SECRET_KEY: "test-mpp-secret",
    });
    const response = await worker.fetch(
      new Request("https://example.test/v1/leases", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(200);
    const req = lastRequest();
    expect(req?.headers.get("x-crabbox-auth")).toBe("mpp");
    expect(req?.headers.get("x-crabbox-owner")).toBe(
      "mpp:0x3b098a4bd4fd4414be203c39057a82a00cd0d33f",
    );
    expect(req?.headers.get("x-crabbox-payer")).toBeNull();
  });

  it("propagates the credential payer onto x-crabbox-payer when MPP request carries one", async () => {
    const { env, lastRequest } = fakeEnv({
      CRABBOX_MPP_RECIPIENT: "0x3B098A4Bd4fd4414Be203c39057A82a00CD0d33F",
      CRABBOX_MPP_SECRET_KEY: "test-mpp-secret",
    });
    const credential = {
      challenge: { id: "abc" },
      payload: { type: "transaction", signature: "0xff" },
      source: "did:pkh:eip155:4217:0xD6242951159Ec311f5810b2b9fC6427999D6a336",
    };
    const b64 = Buffer.from(JSON.stringify(credential), "utf-8")
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    const response = await worker.fetch(
      new Request("https://example.test/v1/leases", {
        method: "POST",
        headers: { Authorization: `Payment ${b64}` },
      }),
      env,
    );
    expect(response.status).toBe(200);
    const req = lastRequest();
    expect(req?.headers.get("x-crabbox-owner")).toBe(
      "mpp:0xd6242951159ec311f5810b2b9fc6427999d6a336",
    );
    expect(req?.headers.get("x-crabbox-payer")).toBe("0xd6242951159ec311f5810b2b9fc6427999d6a336");
  });

  it("upgrades an authenticated request with the credential payer when both are present", async () => {
    const { env, lastRequest } = fakeEnv({
      CRABBOX_ADMIN_TOKEN: "admin-token",
      CRABBOX_MPP_RECIPIENT: "0x3B098A4Bd4fd4414Be203c39057A82a00CD0d33F",
      CRABBOX_MPP_SECRET_KEY: "test-mpp-secret",
    });
    const credential = {
      source: "did:pkh:eip155:4217:0xAA000000000000000000000000000000000000Bb",
    };
    const b64 = Buffer.from(JSON.stringify(credential), "utf-8")
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    const response = await worker.fetch(
      new Request("https://example.test/v1/leases", {
        method: "POST",
        headers: {
          Authorization: `Bearer admin-token`,
          "x-crabbox-payment": `Payment ${b64}`,
        },
      }),
      env,
    );
    expect(response.status).toBe(200);
    const req = lastRequest();
    expect(req?.headers.get("x-crabbox-auth")).toBe("bearer");
    expect(req?.headers.get("x-crabbox-payer")).toBe("0xAA000000000000000000000000000000000000Bb");
  });

  it("rejects heartbeat on an unconfigured-MPP coordinator with 401", async () => {
    const { env } = fakeEnv();
    const response = await worker.fetch(
      new Request("https://example.test/v1/leases/cbx_aaaaaaaaaaaa/heartbeat", {
        method: "POST",
      }),
      env,
    );
    expect(response.status).toBe(401);
  });
});

describe("extractCredentialPayer", () => {
  it("returns the payer address from a did:pkh source", () => {
    const credential = {
      challenge: { id: "abc", realm: "test" },
      payload: { type: "transaction", signature: "0xff" },
      source: "did:pkh:eip155:4217:0xD6242951159Ec311f5810b2b9fC6427999D6a336",
    };
    const request = new Request("https://example.test/v1/leases", {
      method: "POST",
      headers: { Authorization: paymentHeader(credential) },
    });
    expect(extractCredentialPayer(request)).toBe("0xD6242951159Ec311f5810b2b9fC6427999D6a336");
  });

  it("returns undefined for missing Authorization", () => {
    const request = new Request("https://example.test/v1/leases", { method: "POST" });
    expect(extractCredentialPayer(request)).toBeUndefined();
  });

  it("returns undefined for non-Payment scheme", () => {
    const request = new Request("https://example.test/v1/leases", {
      method: "POST",
      headers: { Authorization: "Bearer some-token" },
    });
    expect(extractCredentialPayer(request)).toBeUndefined();
  });

  it("returns undefined for malformed credential", () => {
    const request = new Request("https://example.test/v1/leases", {
      method: "POST",
      headers: { Authorization: "Payment not-base64-at-all" },
    });
    expect(extractCredentialPayer(request)).toBeUndefined();
  });
});
