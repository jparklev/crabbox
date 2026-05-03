import { Mppx, Store, tempo } from "mppx/server";
import { Session } from "mppx/tempo";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempo as tempoChain, tempoTestnet } from "viem/chains";

import type { Env } from "./types";

const PATH_USD_TEMPO = "0x20c0000000000000000000000000000000000000";

export type SessionCredentialPayload = {
  action?: string;
  authorizedSigner?: string;
  channelId?: string;
  cumulativeAmount?: string;
};

export type PaymentCredential = {
  source?: string;
  payload?: SessionCredentialPayload;
};

export type SessionAcceptance = {
  channelID: string;
  cumulativeAmountUnits: string;
  cumulativeAmountUSD: number;
  sessionKey?: string;
  payer?: string;
};

export type SessionResult =
  | { status: 402; challenge: Response }
  | { accepted?: SessionAcceptance; withReceipt: (response: Response) => Response };

export interface PaymentGuard {
  session(amountUSD: number, options: SessionOptions): (request: Request) => Promise<SessionResult>;
  settle(channelID: string): Promise<string | undefined>;
  settleZero(_acceptance: SessionAcceptance): Promise<void>;
}

export interface SessionOptions {
  scope: string;
  description: string;
  spendingLimitUSD: number;
  minVoucherDeltaUSD?: number;
}

export function isSessionChallenge(
  result: SessionResult,
): result is { status: 402; challenge: Response } {
  return "challenge" in result;
}

export class MppxConfigError extends Error {}

export function paymentEnabled(env: Env): boolean {
  return Boolean(env.CRABBOX_MPP_RECIPIENT?.trim());
}

export function paymentGuardFromEnv(
  env: Env,
  storage?: DurableObjectStorage,
): PaymentGuard | undefined {
  const recipient = env.CRABBOX_MPP_RECIPIENT?.trim();
  if (!recipient) {
    return undefined;
  }
  if (!isAddress(recipient)) {
    throw new MppxConfigError("CRABBOX_MPP_RECIPIENT must be a 0x… 20-byte address");
  }
  const currency = env.CRABBOX_MPP_CURRENCY?.trim() || PATH_USD_TEMPO;
  if (!isAddress(currency)) {
    throw new MppxConfigError("CRABBOX_MPP_CURRENCY must be a 0x… 20-byte address");
  }
  if (!env.CRABBOX_MPP_SECRET_KEY?.trim()) {
    throw new MppxConfigError("CRABBOX_MPP_SECRET_KEY is required when MPP is enabled");
  }
  const settlementKey = env.CRABBOX_MPP_SETTLEMENT_PRIVATE_KEY?.trim();
  if (!settlementKey) {
    throw new MppxConfigError(
      "CRABBOX_MPP_SETTLEMENT_PRIVATE_KEY is required when MPP session metering is enabled",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(settlementKey)) {
    throw new MppxConfigError("CRABBOX_MPP_SETTLEMENT_PRIVATE_KEY must be a 0x… 32-byte key");
  }
  if (!env.CRABBOX_SESSION_SECRET?.trim()) {
    throw new MppxConfigError(
      "CRABBOX_SESSION_SECRET is required when MPP is enabled (used to sign lease bearers)",
    );
  }
  const decimals = parseDecimals(env.CRABBOX_MPP_DECIMALS) ?? 6;
  const testnet = parseBool(env.CRABBOX_MPP_TESTNET);
  const settlementAccount = privateKeyToAccount(settlementKey as Hex);
  const chain = testnet ? tempoTestnet : tempoChain;
  const walletClient = createWalletClient({
    account: settlementAccount,
    chain,
    transport: http(env.CRABBOX_MPP_RPC_URL?.trim() || undefined),
  });
  const store = storage ? doStorageStore(storage) : undefined;
  const channelStore = store ? Session.ChannelStore.fromStore(store) : undefined;
  const tempoConfig: {
    currency: `0x${string}`;
    recipient: `0x${string}`;
    decimals: number;
    account: ReturnType<typeof privateKeyToAccount>;
    testnet?: boolean;
    store?: Store.AtomicStore;
  } = { account: settlementAccount, currency, recipient, decimals };
  if (testnet) {
    tempoConfig.testnet = true;
  }
  if (store) {
    tempoConfig.store = store;
  }
  const secretKey = env.CRABBOX_MPP_SECRET_KEY;
  const realm = env.CRABBOX_MPP_REALM?.trim();
  const mppx = realm
    ? Mppx.create({
        methods: [tempo.session(tempoConfig)],
        secretKey,
        realm,
      })
    : Mppx.create({ methods: [tempo.session(tempoConfig)], secretKey });
  return {
    session: (amountUSD: number, options: SessionOptions) => async (request: Request) => {
      const response = await mppx.tempo.session({
        amount: formatAmountUSD(amountUSD),
        description: options.description,
        minVoucherDelta: formatAmountUSD(options.minVoucherDeltaUSD ?? 0.000001),
        scope: options.scope,
        suggestedDeposit: formatAmountUSD(options.spendingLimitUSD),
        unitType: "usd",
      })(request);
      if (response.status === 402) {
        return { status: 402, challenge: withSessionLimit(response.challenge, options) };
      }
      const accepted = sessionAcceptanceFromRequest(request, decimals);
      const result: SessionResult = { withReceipt: (out: Response) => response.withReceipt(out) };
      if (accepted) {
        result.accepted = accepted;
      }
      return result;
    },
    settle: async (channelID: string) => {
      if (!channelStore) {
        return undefined;
      }
      return tempo.settle(channelStore, walletClient, channelID as Hex, {
        account: settlementAccount,
      });
    },
    settleZero: async () => {
      // A failed provision must not be settled against the user. The open channel
      // can remain unclaimed; settlement is intentionally skipped.
    },
  };
}

export function paymentConfigured(env: Env): boolean {
  if (!paymentEnabled(env)) {
    return false;
  }
  try {
    return Boolean(paymentGuardFromEnv(env));
  } catch {
    return false;
  }
}

export function formatAmountUSD(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) {
    return "0.000001";
  }
  return amount.toFixed(6);
}

export function parsePaymentCredential(request: Request): PaymentCredential | undefined {
  const auth = paymentAuthorization(request);
  if (!auth) {
    return undefined;
  }
  try {
    const token = auth.slice(8);
    const padded = token
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(token.length / 4) * 4, "=");
    return JSON.parse(atob(padded)) as PaymentCredential;
  } catch {
    return undefined;
  }
}

export function paymentAuthorization(request: Request): string | undefined {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Payment ")) {
    return auth;
  }
  const payment = request.headers.get("x-crabbox-payment");
  return payment?.startsWith("Payment ") ? payment : undefined;
}

export function credentialPayer(credential: PaymentCredential | undefined): string | undefined {
  const source = credential?.source;
  if (typeof source !== "string") {
    return undefined;
  }
  const match = /:0x([a-fA-F0-9]{40})$/.exec(source);
  return match ? `0x${match[1]}` : undefined;
}

function sessionAcceptanceFromRequest(
  request: Request,
  decimals: number,
): SessionAcceptance | undefined {
  const credential = parsePaymentCredential(request);
  const payload = credential?.payload;
  if (!payload?.channelId || !payload.cumulativeAmount) {
    return undefined;
  }
  const accepted: SessionAcceptance = {
    channelID: payload.channelId,
    cumulativeAmountUnits: payload.cumulativeAmount,
    cumulativeAmountUSD: unitsToUSD(payload.cumulativeAmount, decimals),
  };
  const payer = credentialPayer(credential)?.toLowerCase();
  if (payer) {
    accepted.payer = payer;
  }
  if (payload.authorizedSigner) {
    accepted.sessionKey = payload.authorizedSigner.toLowerCase();
  }
  return accepted;
}

function unitsToUSD(value: string, decimals: number): number {
  try {
    const units = BigInt(value);
    const scale = 10 ** decimals;
    return Number(units) / scale;
  } catch {
    return 0;
  }
}

function withSessionLimit(response: Response, options: SessionOptions): Response {
  const headers = new Headers(response.headers);
  const www = headers.get("www-authenticate");
  if (www && !/\blimit=/.test(www)) {
    headers.set("www-authenticate", `${www}, limit="${formatAmountUSD(options.spendingLimitUSD)}"`);
  }
  return new Response(response.body, { status: response.status, headers });
}

function parseDecimals(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 32 ? parsed : undefined;
}

function parseBool(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function isAddress(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

// DO storage is single-threaded per object, so naive read-modify-write inside
// `update` is atomic by definition; no explicit transaction is needed.
function doStorageStore(storage: DurableObjectStorage): Store.AtomicStore {
  const prefix = "mpp:";
  return Store.cloudflare({
    get: async (key: string) => (await storage.get<string>(prefix + key)) ?? null,
    put: async (key: string, value: string) => {
      await storage.put(prefix + key, value);
    },
    delete: async (key: string) => {
      await storage.delete(prefix + key);
    },
    update: async (key, fn) => {
      const k = prefix + key;
      const current = (await storage.get<string>(k)) ?? null;
      const change = fn(current);
      if (change.op === "set") {
        await storage.put(k, change.value);
      } else if (change.op === "delete") {
        await storage.delete(k);
      }
      return change.result;
    },
  });
}
