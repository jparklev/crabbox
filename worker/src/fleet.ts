import { isAdminRequest, issueLeaseToken, requestLeaseAuth, requestPayer } from "./auth";
import { EC2SpotClient } from "./aws";
import { leaseConfig, validCIDRs } from "./config";
import { HetznerClient } from "./hetzner";
import { errorMessage, json, pathParts, readJson, requestOwner } from "./http";
import { githubAuthRoute } from "./oauth";
import { paymentGuardFromEnv, type PaymentGuard, type SessionAcceptance } from "./payments";
import { leaseSlugFromID, normalizeLeaseSlug, slugWithCollisionSuffix } from "./slug";
import type {
  Env,
  LeaseRecord,
  LeaseRequest,
  Provider,
  ProviderImage,
  ProviderMachine,
  ProvisioningAttempt,
  PromotedImageRecord,
  RunCreateRequest,
  RunEventRecord,
  RunEventRequest,
  RunFinishRequest,
  RunRecord,
  TestFailure,
  TestResultSummary,
} from "./types";
import { costLimits, enforceCostLimits, leaseCost, requestOrg, usageSummary } from "./usage";

const fleetID = "default";
const maxStoredRunLogBytes = 8 * 1024 * 1024;
const runLogChunkBytes = 64 * 1024;
const meteredLeaseGraceMs = 30_000;
const liquidityCheckIntervalMs = 10 * 60_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class FleetDurableObject implements DurableObject {
  private cachedPaymentGuard: PaymentGuard | null | undefined;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
    private readonly testProviders: Partial<Record<Provider, CloudProvider>> = {},
    private readonly testPaymentGuard?: PaymentGuard,
  ) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const parts = pathParts(request);
      const method = request.method.toUpperCase();
      if (method === "GET" && parts.join("/") === "v1/health") {
        return json({ ok: true, fleet: fleetID });
      }
      if (parts[0] === "v1" && parts[1] === "auth" && parts[2] === "github") {
        return await githubAuthRoute(request, parts[3], this.state.storage, this.env);
      }
      if (method === "GET" && parts.join("/") === "v1/pool") {
        if (!isAdminRequest(request)) {
          return json({ error: "forbidden", message: "admin token required" }, { status: 403 });
        }
        return await this.pool(request);
      }
      if (method === "GET" && parts.join("/") === "v1/usage") {
        return await this.usage(request);
      }
      if (method === "GET" && parts.join("/") === "v1/whoami") {
        return this.whoami(request);
      }
      if (method === "GET" && parts.join("/") === "v1/admin/leases") {
        if (!isAdminRequest(request)) {
          return json({ error: "forbidden", message: "admin token required" }, { status: 403 });
        }
        return await this.adminLeases(request);
      }
      if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "leases" && parts[3]) {
        if (!isAdminRequest(request)) {
          return json({ error: "forbidden", message: "admin token required" }, { status: 403 });
        }
        return await this.adminLeaseRoute(request, parts[3], parts[4]);
      }
      if (method === "GET" && parts.join("/") === "v1/runs") {
        return await this.listRuns(request);
      }
      if (method === "POST" && parts.join("/") === "v1/runs") {
        return await this.createRun(request);
      }
      if (parts[0] === "v1" && parts[1] === "runs" && parts[2]) {
        return await this.runRoute(request, parts[2], parts[3]);
      }
      if (method === "POST" && parts.join("/") === "v1/images") {
        if (!isAdminRequest(request)) {
          return json({ error: "forbidden", message: "admin token required" }, { status: 403 });
        }
        return await this.createImage(request);
      }
      if (parts[0] === "v1" && parts[1] === "images" && parts[2]) {
        if (!isAdminRequest(request)) {
          return json({ error: "forbidden", message: "admin token required" }, { status: 403 });
        }
        return await this.imageRoute(request, parts[2], parts[3]);
      }
      if (method === "GET" && parts.join("/") === "v1/leases") {
        return await this.listLeases(request);
      }
      if (method === "POST" && parts.join("/") === "v1/leases") {
        return await this.createLease(request);
      }
      if (parts[0] === "v1" && parts[1] === "leases" && parts[2]) {
        return await this.leaseRoute(request, parts[2], parts[3]);
      }
      return json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async alarm(): Promise<void> {
    await this.expireLeases();
    await this.scheduleAlarm();
  }

  private async createLease(request: Request): Promise<Response> {
    const owner = requestOwner(request);
    const org = requestOrg(request, this.env);
    const requestForPayment = request.clone();
    const input = await readJson<LeaseRequest>(request);
    const config = leaseConfig(input);
    if (config.provider === "aws" && config.awsSSHCIDRs.length === 0) {
      config.awsSSHCIDRs = requestSourceCIDRs(request);
    }
    const imageTag = normalizeTag(input.imageTag);
    if (config.provider === "aws" && !config.awsAMI) {
      config.awsAMI = (await this.promotedImage("aws", imageTag))?.id ?? "";
    }
    if (config.provider === "hetzner" && input.image === undefined) {
      const promoted = await this.promotedImage("hetzner", imageTag);
      if (promoted) {
        config.image = promoted.id;
      }
    }
    const leaseID = validLeaseID(input.leaseID) ? input.leaseID : newLeaseID();
    const leases = await this.leaseRecords();
    const slug = allocateLeaseSlug(
      normalizeLeaseSlug(input.slug ?? input.requestedSlug) || leaseSlugFromID(leaseID),
      leaseID,
      owner,
      org,
      leases,
    );
    const provider = this.provider(config.provider, config.awsRegion);
    const providerHourlyUSD = await provider
      .hourlyPriceUSD(config.serverType, config)
      .catch(() => undefined);
    const cost = leaseCost(
      this.env,
      config.provider,
      config.serverType,
      config.ttlSeconds,
      providerHourlyUSD,
    );
    const spendingLimitUSD = requestedSpendingLimitUSD(input, cost.maxUSD);
    const burnEstimateUSDPerMinute = cost.hourlyUSD / 60;
    const now = new Date();
    const record: LeaseRecord = {
      id: leaseID,
      slug,
      provider: config.provider,
      cloudID: "",
      owner,
      org,
      profile: config.profile,
      class: config.class,
      serverType: config.serverType,
      requestedServerType: config.serverType,
      serverID: 0,
      serverName: "",
      providerKey: config.providerKey,
      host: "",
      sshUser: config.sshUser,
      sshPort: config.sshPort,
      sshFallbackPorts: config.sshFallbackPorts,
      workRoot: config.workRoot,
      keep: config.keep,
      ttlSeconds: config.ttlSeconds,
      idleTimeoutSeconds: config.idleTimeoutSeconds,
      estimatedHourlyUSD: cost.hourlyUSD,
      maxEstimatedUSD: spendingLimitUSD,
      state: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastTouchedAt: now.toISOString(),
      expiresAt: leaseExpiresAt(
        now,
        now,
        config.ttlSeconds,
        config.idleTimeoutSeconds,
      ).toISOString(),
      spendingLimitUSD,
      burnRateUSDPerMinute: burnEstimateUSDPerMinute,
      billingStartedAt: now.toISOString(),
      sshPublicKey: config.sshPublicKey,
      resumeRequest: input,
    };
    const limitError = enforceCostLimits(leases, record, costLimits(this.env), now);
    if (limitError) {
      return json({ error: "cost_limit_exceeded", message: limitError }, { status: 429 });
    }
    const guard = this.paymentGuard();
    let attachReceipt: ((response: Response) => Response) | undefined;
    let acceptedSession: SessionAcceptance | undefined;
    if (guard) {
      const depositUSD = twoMinuteBufferUSD(burnEstimateUSDPerMinute);
      const session = await guard.session(depositUSD, {
        description: "Crabbox lease session",
        scope: `lease:${leaseID}:create`,
        spendingLimitUSD,
      })(requestForPayment);
      if ("challenge" in session) {
        return session.challenge;
      }
      acceptedSession = session.accepted;
      attachReceipt = (response) => session.withReceipt(response);
    }
    const provisioned = await provider.createServerWithFallback(config, leaseID, slug, owner);
    const { server, serverType, attempts } = provisioned;
    record.cloudID = server.cloudID;
    record.serverType = serverType;
    if (attempts && attempts.length > 0) {
      record.provisioningAttempts = attempts;
    }
    record.serverID = server.id;
    record.serverName = server.name;
    record.host = server.host;
    const finalProviderHourlyUSD = await provider
      .hourlyPriceUSD(serverType, config)
      .catch(() => undefined);
    const finalCost = leaseCost(
      this.env,
      config.provider,
      serverType,
      config.ttlSeconds,
      finalProviderHourlyUSD,
    );
    record.estimatedHourlyUSD = finalCost.hourlyUSD;
    record.maxEstimatedUSD = spendingLimitUSD;
    record.burnRateUSDPerMinute = finalCost.hourlyUSD / 60;
    if (config.provider === "aws") {
      record.region = config.awsRegion;
    }
    const payer = requestPayer(request).toLowerCase();
    if (payer) {
      record.payer = payer;
    }
    if (guard && acceptedSession) {
      applyAcceptedSession(record, acceptedSession);
      record.paymentCoveredUntil = paymentCoveredUntil(record, now).toISOString();
      record.expiresAt = record.paymentCoveredUntil;
    }
    await this.putLease(record);
    await this.scheduleAlarm();
    const responseBody: { lease: LeaseRecord; bearer?: string } = { lease: record };
    if (request.headers.get("x-crabbox-auth") === "mpp") {
      responseBody.bearer = await issueLeaseToken(this.env, {
        leaseID: record.id,
        owner: record.owner,
        org: record.org,
        ttlSeconds: record.ttlSeconds,
      });
    }
    const response = json(responseBody, { status: 201 });
    return attachReceipt ? attachReceipt(response) : response;
  }

  private paymentGuard(): PaymentGuard | undefined {
    if (this.testPaymentGuard) {
      return this.testPaymentGuard;
    }
    if (this.cachedPaymentGuard === undefined) {
      try {
        this.cachedPaymentGuard = paymentGuardFromEnv(this.env, this.state.storage) ?? null;
      } catch {
        this.cachedPaymentGuard = null;
      }
    }
    return this.cachedPaymentGuard ?? undefined;
  }

  private async leaseRoute(request: Request, leaseID: string, action?: string): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method === "GET" && action === undefined) {
      const lease = await this.resolveLease(leaseID, request, false);
      return lease ? json({ lease }) : notFound();
    }
    if (method === "POST" && action === "heartbeat") {
      const lease = await this.resolveLease(leaseID, request, false);
      if (!lease) {
        return notFound();
      }
      const metered = await this.acceptMeteredVoucher(request, lease, "heartbeat");
      if (metered) {
        return metered;
      }
      const body = await optionalJson<{ idleTimeoutSeconds?: number }>(request);
      const now = new Date();
      const requestedIdleTimeoutSeconds = body.idleTimeoutSeconds;
      if (
        Number.isFinite(requestedIdleTimeoutSeconds) &&
        requestedIdleTimeoutSeconds !== undefined &&
        requestedIdleTimeoutSeconds > 0
      ) {
        lease.idleTimeoutSeconds = clampLeaseSeconds(requestedIdleTimeoutSeconds, 86_400);
      }
      lease.updatedAt = now.toISOString();
      lease.lastTouchedAt = now.toISOString();
      lease.expiresAt = lease.sessionID
        ? paymentCoveredUntil(lease, now).toISOString()
        : recomputeLeaseExpiresAt(lease, now).toISOString();
      await this.putLease(lease);
      await this.scheduleAlarm();
      return json({ lease });
    }
    if (method === "POST" && action === "release") {
      return this.releaseLease(request, leaseID, false);
    }
    if (method === "POST" && action === "resume") {
      return this.resumeLease(request, leaseID);
    }
    return json({ error: "not_found" }, { status: 404 });
  }

  private async releaseLease(request: Request, leaseID: string, admin: boolean): Promise<Response> {
    const lease = await this.resolveLease(leaseID, request, admin);
    if (!lease) {
      return notFound();
    }
    const metered = await this.acceptMeteredVoucher(request, lease, "release");
    if (metered) {
      return metered;
    }
    const body = await optionalJson<{ delete?: boolean }>(request);
    const shouldDelete = body.delete ?? !lease.keep;
    if (shouldDelete && lease.state === "active") {
      await this.deleteLeaseServer(lease);
    }
    if (lease.sessionID) {
      await this.settleLease(lease);
    }
    const now = new Date().toISOString();
    lease.state = "released";
    lease.updatedAt = now;
    lease.releasedAt = now;
    lease.endedAt = now;
    await this.putLease(lease);
    return json({ lease });
  }

  private async resumeLease(request: Request, leaseID: string): Promise<Response> {
    const requestForPayment = request.clone();
    const lease = await this.resolveLease(leaseID, request, false);
    if (!lease) {
      return notFound();
    }
    if (lease.state !== "hibernated") {
      return json({ error: "lease_not_hibernated" }, { status: 409 });
    }
    if (!lease.snapshotID) {
      return json({ error: "snapshot_missing" }, { status: 409 });
    }
    if (!lease.sshPublicKey) {
      return json({ error: "ssh_public_key_missing" }, { status: 409 });
    }
    const input = await optionalJson<LeaseRequest>(request);
    const resumeRequest: LeaseRequest = {
      ...lease.resumeRequest,
      ...input,
      leaseID: lease.id,
      provider: lease.provider,
      sshPublicKey: lease.sshPublicKey,
    };
    if (lease.provider === "aws") {
      resumeRequest.awsAMI = lease.snapshotID;
    } else {
      resumeRequest.image = lease.snapshotID;
    }
    const config = leaseConfig(resumeRequest);
    const guard = this.paymentGuard();
    let attachReceipt: ((response: Response) => Response) | undefined;
    if (guard) {
      const spendingLimitUSD = requestedSpendingLimitUSD(
        resumeRequest,
        lease.spendingLimitUSD ?? lease.maxEstimatedUSD ?? 1,
      );
      const session = await guard.session(twoMinuteBufferUSD(lease.burnRateUSDPerMinute ?? 0), {
        description: "Crabbox resume session",
        scope: `lease:${lease.id}:resume`,
        spendingLimitUSD,
      })(requestForPayment);
      if ("challenge" in session) {
        return session.challenge;
      }
      if (session.accepted) {
        applyAcceptedSession(lease, session.accepted);
        lease.spendingLimitUSD = spendingLimitUSD;
      }
      attachReceipt = (response) => session.withReceipt(response);
    }
    const provider = this.provider(config.provider, config.awsRegion);
    const { server, serverType, attempts } = await provider.createServerWithFallback(
      config,
      lease.id,
      lease.slug ?? leaseSlugFromID(lease.id),
      lease.owner,
    );
    const now = new Date();
    lease.cloudID = server.cloudID;
    lease.serverID = server.id;
    lease.serverName = server.name;
    lease.host = server.host;
    lease.serverType = serverType;
    if (attempts) {
      lease.provisioningAttempts = attempts;
    }
    lease.state = "active";
    lease.updatedAt = now.toISOString();
    lease.lastTouchedAt = now.toISOString();
    lease.billingStartedAt = now.toISOString();
    lease.resumedFromSnapshotID = lease.snapshotID;
    delete lease.snapshotID;
    delete lease.hibernatedAt;
    lease.burnRateUSDPerMinute = (lease.estimatedHourlyUSD ?? 0) / 60;
    lease.paymentCoveredUntil = paymentCoveredUntil(lease, now).toISOString();
    lease.expiresAt = lease.sessionID
      ? lease.paymentCoveredUntil
      : recomputeLeaseExpiresAt(lease, now).toISOString();
    await this.putLease(lease);
    await this.scheduleAlarm();
    const response = json({ lease });
    return attachReceipt ? attachReceipt(response) : response;
  }

  private async acceptMeteredVoucher(
    request: Request,
    lease: LeaseRecord,
    action: "heartbeat" | "release",
  ): Promise<Response | undefined> {
    if (!lease.sessionID) {
      return undefined;
    }
    const guard = this.paymentGuard();
    if (!guard) {
      return json(
        { error: "payment_required", message: "payment guard unavailable" },
        { status: 402 },
      );
    }
    const now = new Date();
    const dueUSD = Math.max(0, voucherRequiredUSD(lease, now) - (lease.highestVoucherHeldUSD ?? 0));
    if (action === "heartbeat" && dueUSD <= 0) {
      lease.paymentCoveredUntil = paymentCoveredUntil(lease, now).toISOString();
      return undefined;
    }
    const minUSD = action === "release" ? 0.000001 : dueUSD || 0.000001;
    const session = await guard.session(minUSD, {
      description: `Crabbox lease ${action}`,
      scope: `lease:${lease.id}:${action}`,
      spendingLimitUSD: lease.spendingLimitUSD ?? lease.maxEstimatedUSD ?? minUSD,
    })(request.clone());
    if ("challenge" in session) {
      return session.challenge;
    }
    if (session.accepted) {
      if (session.accepted.channelID.toLowerCase() !== lease.sessionID.toLowerCase()) {
        return json({ error: "session_mismatch" }, { status: 403 });
      }
      applyAcceptedSession(lease, session.accepted);
    }
    lease.paymentCoveredUntil = paymentCoveredUntil(lease, now).toISOString();
    return undefined;
  }

  private whoami(request: Request): Response {
    return json({
      owner: requestOwner(request),
      org: requestOrg(request, this.env),
      auth: request.headers.get("x-crabbox-auth") || "bearer",
    });
  }

  private async pool(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const provider = url.searchParams.get("provider");
    const machines =
      provider === "aws"
        ? await this.provider("aws").listCrabboxServers()
        : provider === "hetzner"
          ? await this.provider("hetzner").listCrabboxServers()
          : [
              ...(await this.provider("hetzner").listCrabboxServers()),
              ...(await this.provider("aws")
                .listCrabboxServers()
                .catch(() => [])),
            ];
    return json({ machines });
  }

  private async listLeases(request: Request): Promise<Response> {
    const leases = isAdminRequest(request)
      ? this.filterLeases(await this.leaseRecords(), request)
      : this.filterLeasesForRequest(await this.leaseRecords(), request);
    return json({ leases });
  }

  private async adminLeases(request: Request): Promise<Response> {
    return json({ leases: this.filterLeases(await this.leaseRecords(), request) });
  }

  private async adminLeaseRoute(
    request: Request,
    leaseID: string,
    action?: string,
  ): Promise<Response> {
    if (request.method.toUpperCase() !== "POST") {
      return json({ error: "not_found" }, { status: 404 });
    }
    if (action === "release") {
      return this.releaseLease(request, leaseID, true);
    }
    if (action === "delete") {
      return this.adminDeleteLease(request, leaseID);
    }
    return json({ error: "not_found" }, { status: 404 });
  }

  private async adminDeleteLease(request: Request, leaseID: string): Promise<Response> {
    const lease = await this.resolveLease(leaseID, request, true);
    if (!lease) {
      return notFound();
    }
    if (lease.state === "active") {
      await this.deleteLeaseServer(lease);
    }
    const now = new Date().toISOString();
    lease.state = "released";
    lease.updatedAt = now;
    lease.releasedAt = now;
    lease.endedAt = now;
    lease.keep = false;
    await this.putLease(lease);
    return json({ lease });
  }

  private filterLeases(leases: LeaseRecord[], request: Request): LeaseRecord[] {
    const url = new URL(request.url);
    const state = url.searchParams.get("state") ?? "";
    const owner = url.searchParams.get("owner") ?? "";
    const org = url.searchParams.get("org") ?? "";
    const limit = clampLimit(url.searchParams.get("limit"), 100);
    return leases
      .filter((lease) => !state || lease.state === state)
      .filter((lease) => !owner || lease.owner === owner)
      .filter((lease) => !org || lease.org === org)
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  private async createRun(request: Request): Promise<Response> {
    const owner = requestOwner(request);
    const org = requestOrg(request, this.env);
    const input = await readJson<RunCreateRequest>(request);
    const leaseID = input.leaseID ?? "";
    if (leaseID && !validLeaseID(leaseID)) {
      return json({ error: "invalid_lease_id" }, { status: 400 });
    }
    const lease = leaseID ? await this.getLease(leaseID) : undefined;
    if (lease && !this.leaseVisibleToRequest(lease, request, false)) {
      return json({ error: "not_found" }, { status: 404 });
    }
    const now = new Date().toISOString();
    const run: RunRecord = {
      id: newRunID(),
      leaseID,
      owner,
      org,
      provider: lease?.provider ?? input.provider ?? "hetzner",
      class: lease?.class ?? input.class ?? "",
      serverType: lease?.serverType ?? input.serverType ?? "",
      command: Array.isArray(input.command) ? input.command.map(String) : [],
      state: "running",
      phase: "starting",
      logBytes: 0,
      logTruncated: false,
      startedAt: now,
      lastEventAt: now,
      eventCount: 0,
    };
    if (lease?.slug) {
      run.slug = lease.slug;
    }
    await this.putRun(run);
    await this.appendRunEventRecord(run, { type: "run.started", phase: "starting" });
    return json({ run }, { status: 201 });
  }

  private async runRoute(request: Request, runID: string, action?: string): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method === "GET" && action === undefined) {
      const run = await this.getRun(runID);
      return run && this.runVisibleToRequest(run, request) ? json({ run }) : notFound();
    }
    if (method === "GET" && action === "logs") {
      const run = await this.getRun(runID);
      if (!run || !this.runVisibleToRequest(run, request)) {
        return notFound();
      }
      const log = await this.readRunLog(runID);
      return new Response(log, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (method === "GET" && action === "events") {
      const run = await this.getRun(runID);
      if (!run || !this.runVisibleToRequest(run, request)) {
        return notFound();
      }
      const url = new URL(request.url);
      const after = finiteQueryNumber(url.searchParams.get("after")) ?? 0;
      const limit = clampLimit(url.searchParams.get("limit"), 500);
      return json({ events: await this.runEvents(runID, after, limit) });
    }
    if (method === "POST" && action === "events") {
      const run = await this.getRun(runID);
      if (!run || !this.runVisibleToRequest(run, request)) {
        return notFound();
      }
      const input = await readJson<RunEventRequest>(request);
      const event = await this.appendRunEventRecord(run, input);
      return json({ event }, { status: 201 });
    }
    if (method === "POST" && action === "finish") {
      return this.finishRun(request, runID);
    }
    return json({ error: "not_found" }, { status: 404 });
  }

  private async finishRun(request: Request, runID: string): Promise<Response> {
    const run = await this.getRun(runID);
    if (!run || !this.runVisibleToRequest(run, request)) {
      return notFound();
    }
    const input = await readJson<RunFinishRequest>(request);
    const now = new Date();
    const started = Date.parse(run.startedAt);
    run.exitCode = Number.isFinite(input.exitCode) ? input.exitCode : 1;
    const syncMs = finiteNumber(input.syncMs);
    const commandMs = finiteNumber(input.commandMs);
    if (syncMs !== undefined) {
      run.syncMs = syncMs;
    }
    if (commandMs !== undefined) {
      run.commandMs = commandMs;
    }
    if (Number.isFinite(started)) {
      run.durationMs = now.getTime() - started;
    }
    run.state = run.exitCode === 0 ? "succeeded" : "failed";
    run.phase = run.state;
    run.endedAt = now.toISOString();
    const logInput = normalizeRunLogInput(input);
    run.logBytes = logInput.bytes;
    run.logTruncated = logInput.truncated;
    if (input.results) {
      run.results = boundedTestResults(input.results);
    }
    await this.writeRunLog(runID, logInput.log);
    await this.putRun(run);
    await this.appendRunEventRecord(run, {
      type: "command.finished",
      phase: run.state,
      exitCode: run.exitCode,
    });
    return json({ run });
  }

  private async readRunLog(runID: string): Promise<string> {
    const chunks = await this.state.storage.list<string>({ prefix: runLogChunkPrefix(runID) });
    if (chunks.size > 0) {
      return [...chunks.entries()]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([, chunk]) => chunk)
        .join("");
    }
    return (await this.state.storage.get<string>(runLogKey(runID))) ?? "";
  }

  private async writeRunLog(runID: string, log: string): Promise<void> {
    await this.deleteRunLogChunks(runID);
    if (textEncoder.encode(log).byteLength <= runLogChunkBytes) {
      await this.state.storage.put(runLogKey(runID), log);
      return;
    }
    await this.state.storage.put(runLogKey(runID), "");
    const chunks = splitRunLogByBytes(log, runLogChunkBytes);
    await Promise.all(
      chunks.map((chunk, index) => this.state.storage.put(runLogChunkKey(runID, index), chunk)),
    );
  }

  private async deleteRunLogChunks(runID: string): Promise<void> {
    const chunks = await this.state.storage.list<string>({ prefix: runLogChunkPrefix(runID) });
    await Promise.all([...chunks.keys()].map((key) => this.state.storage.delete(key)));
  }

  private async listRuns(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const leaseID = url.searchParams.get("leaseID") ?? "";
    const owner = url.searchParams.get("owner") ?? "";
    const org = url.searchParams.get("org") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const limit = clampLimit(url.searchParams.get("limit"), 50);
    const admin = isAdminRequest(request);
    const runs = await this.runRecords();
    const scopedOwner = admin ? owner : requestOwner(request);
    const scopedOrg = admin ? org : requestOrg(request, this.env);
    const leaseScope = admin ? "" : requestLeaseAuth(request);
    return json({
      runs: runs
        .filter((run) => !leaseID || run.leaseID === leaseID)
        .filter((run) => !scopedOwner || run.owner === scopedOwner)
        .filter((run) => !scopedOrg || run.org === scopedOrg)
        .filter((run) => !leaseScope || run.leaseID === leaseScope)
        .filter((run) => !state || run.state === state)
        .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit),
    });
  }

  private async usage(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const admin = isAdminRequest(request);
    const leaseScope = admin ? "" : requestLeaseAuth(request);
    if (leaseScope) {
      return json(
        { error: "forbidden", message: "lease tokens cannot read usage" },
        { status: 403 },
      );
    }
    const requestedScope = url.searchParams.get("scope") ?? "user";
    const scope =
      admin && (requestedScope === "org" || requestedScope === "all" || requestedScope === "user")
        ? requestedScope
        : "user";
    const month = url.searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
    const owner = admin
      ? (url.searchParams.get("owner") ?? requestOwner(request))
      : requestOwner(request);
    const org = admin
      ? (url.searchParams.get("org") ?? requestOrg(request, this.env))
      : requestOrg(request, this.env);
    const usage = usageSummary(await this.leaseRecords(), { scope, owner, org, month }, new Date());
    return json({ usage, limits: costLimits(this.env) });
  }

  private async createImage(request: Request): Promise<Response> {
    const input = await readJson<{
      leaseID?: string;
      id?: string;
      name?: string;
      noReboot?: boolean;
    }>(request);
    const leaseID = input.leaseID ?? input.id ?? "";
    const name = input.name ?? "";
    if (!validLeaseID(leaseID)) {
      return json({ error: "invalid_lease_id" }, { status: 400 });
    }
    if (!validImageName(name)) {
      return json({ error: "invalid_image_name" }, { status: 400 });
    }
    const lease = await this.resolveLease(leaseID, request, true);
    if (!lease) {
      return notFound();
    }
    if (lease.provider === "aws") {
      if (!lease.cloudID) {
        return json({ error: "lease_not_provisioned" }, { status: 400 });
      }
      const image = await this.provider("aws", lease.region).createImage(
        lease.cloudID,
        name,
        input.noReboot ?? true,
      );
      return json({ image }, { status: 201 });
    }
    if (lease.provider === "hetzner") {
      if (!lease.serverID) {
        return json({ error: "lease_not_provisioned" }, { status: 400 });
      }
      const image = await this.provider("hetzner").createImage(String(lease.serverID), name, false);
      return json({ image }, { status: 201 });
    }
    return json({ error: "unsupported_provider" }, { status: 400 });
  }

  private async imageRoute(request: Request, imageID: string, action?: string): Promise<Response> {
    const method = request.method.toUpperCase();
    if (!validImageID(imageID)) {
      return json({ error: "invalid_image_id" }, { status: 400 });
    }
    const provider: Provider = imageID.startsWith("ami-") ? "aws" : "hetzner";
    if (method === "GET" && action === undefined) {
      const image = await this.provider(provider).getImage(imageID);
      return json({ image });
    }
    if (method === "POST" && action === "promote") {
      const body = await optionalJson<{ tag?: string }>(request);
      const tag = normalizeTag(body.tag);
      const image = await this.provider(provider).getImage(imageID);
      if (image.state !== "available") {
        return json(
          { error: "image_not_available", message: `image ${imageID} is ${image.state}` },
          { status: 409 },
        );
      }
      const promoted: PromotedImageRecord = {
        ...image,
        tag,
        promotedAt: new Date().toISOString(),
      };
      await this.state.storage.put(promotedImageKey(provider, tag), promoted);
      return json({ image: promoted });
    }
    return json({ error: "not_found" }, { status: 404 });
  }

  private async expireLeases(): Promise<void> {
    const leases = await this.state.storage.list<LeaseRecord>({ prefix: "lease:" });
    const now = new Date();
    const nowMs = now.getTime();
    const active = [...leases.values()].filter((lease) => lease.state === "active");
    const expired = active.filter(
      (lease) => !lease.sessionID && Date.parse(lease.expiresAt) <= nowMs,
    );
    const metered = active.filter((lease) => Boolean(lease.sessionID));
    const uncovered = metered.filter(
      (lease) => voucherRequiredUSD(lease, now) > (lease.highestVoucherHeldUSD ?? 0) + 0.000001,
    );
    const closing = await this.closeRequestedLeases(metered);
    const hibernating = [
      ...new Map([...uncovered, ...closing].map((lease) => [lease.id, lease])).values(),
    ];
    await Promise.all(
      expired.map(async (lease) => {
        await this.deleteLeaseServer(lease).catch(() => undefined);
        const nowISO = new Date().toISOString();
        lease.state = "expired";
        lease.updatedAt = nowISO;
        lease.endedAt = nowISO;
        await this.putLease(lease);
      }),
    );
    await Promise.all(hibernating.map((lease) => this.hibernateLease(lease)));
    await this.liquidityCheckLongRunningLeases(active, now);
  }

  private async scheduleAlarm(): Promise<void> {
    const leases = await this.state.storage.list<LeaseRecord>({ prefix: "lease:" });
    const now = new Date();
    const active = [...leases.values()].filter((lease) => lease.state === "active");
    const activeExpiries = active
      .map((lease) => this.nextAlarmTime(lease, now))
      .filter((time) => Number.isFinite(time));
    if (activeExpiries.length === 0) {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(Math.min(...activeExpiries));
  }

  private nextAlarmTime(lease: LeaseRecord, now: Date): number {
    if (!lease.sessionID) {
      return Date.parse(lease.expiresAt);
    }
    const nowMs = now.getTime();
    const coveredUntil = paymentCoveredUntil(lease, now).getTime() + meteredLeaseGraceMs;
    const lastLiquidity = Date.parse(
      lease.lastLiquidityCheckAt ?? lease.billingStartedAt ?? lease.createdAt,
    );
    const nextLiquidity =
      (Number.isFinite(lastLiquidity) ? lastLiquidity : nowMs) + liquidityCheckIntervalMs;
    return Math.min(coveredUntil, nextLiquidity);
  }

  private async closeRequestedLeases(leases: LeaseRecord[]): Promise<LeaseRecord[]> {
    const guard = this.paymentGuard();
    if (!guard) {
      return [];
    }
    const checked = await Promise.all(
      leases.map(async (lease) => {
        const channel = await guard.channel(lease.sessionID ?? "").catch(() => undefined);
        return channel?.closeRequestedAt ? lease : undefined;
      }),
    );
    return checked.filter((lease): lease is LeaseRecord => Boolean(lease));
  }

  private async hibernateLease(lease: LeaseRecord): Promise<void> {
    if (lease.state !== "active") {
      return;
    }
    const now = new Date();
    try {
      const snapshot = await this.snapshotLease(lease);
      lease.snapshotID = snapshot.id;
      lease.snapshotName = snapshot.name;
      await this.waitForImageAvailable(lease.provider, snapshot.id, lease.region);
    } finally {
      await this.deleteLeaseServer(lease).catch(() => undefined);
      lease.state = "hibernated";
      lease.updatedAt = now.toISOString();
      lease.endedAt = now.toISOString();
      lease.hibernatedAt = now.toISOString();
      lease.expiresAt = now.toISOString();
      await this.putLease(lease);
    }
  }

  private async snapshotLease(lease: LeaseRecord): Promise<ProviderImage> {
    const name = `crabbox-hibernate-${lease.id}-${Date.now()}`;
    if (lease.provider === "aws") {
      return this.provider("aws", lease.region).createImage(lease.cloudID, name, true);
    }
    return this.provider("hetzner").createImage(String(lease.serverID), name, false);
  }

  private async waitForImageAvailable(
    providerName: Provider,
    imageID: string,
    region?: string,
  ): Promise<void> {
    const provider = this.provider(providerName, region);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- snapshot polling is intentionally sequential.
      const image = await provider.getImage(imageID).catch(() => undefined);
      if (!image || image.state === "available") {
        return;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- this delay is the polling interval.
      await sleep(2_000);
    }
  }

  private async liquidityCheckLongRunningLeases(leases: LeaseRecord[], now: Date): Promise<void> {
    await Promise.all(
      leases
        .filter((lease) => lease.sessionID)
        .filter((lease) => {
          const last = Date.parse(lease.lastLiquidityCheckAt ?? lease.billingStartedAt ?? "");
          return !Number.isFinite(last) || now.getTime() - last >= liquidityCheckIntervalMs;
        })
        .map(async (lease) => {
          await this.settleLease(lease).catch(() => undefined);
          lease.lastLiquidityCheckAt = now.toISOString();
          await this.putLease(lease);
        }),
    );
  }

  private async settleLease(lease: LeaseRecord): Promise<void> {
    if (!lease.sessionID) {
      return;
    }
    const guard = this.paymentGuard();
    if (!guard) {
      lease.settlementStatus = "failed";
      return;
    }
    try {
      const tx = await guard.settle(lease.sessionID);
      lease.settlementStatus = tx ? "submitted" : "skipped";
      if (tx) {
        lease.settlementTx = tx;
      }
      lease.settledAt = new Date().toISOString();
    } catch {
      lease.settlementStatus = "failed";
    }
  }

  private async getLease(leaseID: string): Promise<LeaseRecord | undefined> {
    return this.state.storage.get<LeaseRecord>(leaseKey(leaseID));
  }

  private async resolveLease(
    identifier: string,
    request: Request,
    admin: boolean,
  ): Promise<LeaseRecord | undefined> {
    const exact = await this.getLease(identifier);
    if (exact) {
      return this.leaseVisibleToRequest(exact, request, admin) ? exact : undefined;
    }
    const slug = normalizeLeaseSlug(identifier);
    if (!slug) {
      return undefined;
    }
    const owner = requestOwner(request);
    const org = requestOrg(request, this.env);
    const now = Date.now();
    let matches = (await this.leaseRecords()).filter(
      (lease) =>
        lease.state === "active" &&
        Date.parse(lease.expiresAt) > now &&
        normalizeLeaseSlug(lease.slug) === slug,
    );
    if (!admin) {
      matches = matches.filter((lease) => lease.owner === owner && lease.org === org);
    }
    if (matches.length > 1) {
      throw new Error(
        `ambiguous slug ${slug}: ${matches.map((lease) => `${lease.id}:${lease.owner}`).join(", ")}`,
      );
    }
    return matches[0];
  }

  private async leaseRecords(): Promise<LeaseRecord[]> {
    const leases = await this.state.storage.list<LeaseRecord>({ prefix: "lease:" });
    return [...leases.values()];
  }

  private async runRecords(): Promise<RunRecord[]> {
    const runs = await this.state.storage.list<RunRecord>({ prefix: "run:" });
    return [...runs.values()];
  }

  private async runEvents(runID: string, after = 0, limit = 500): Promise<RunEventRecord[]> {
    const events = await this.state.storage.list<RunEventRecord>({
      prefix: runEventPrefix(runID),
    });
    return [...events.values()]
      .toSorted((a, b) => a.seq - b.seq)
      .filter((event) => event.seq > after)
      .slice(0, limit);
  }

  private filterLeasesForRequest(leases: LeaseRecord[], request: Request): LeaseRecord[] {
    const owner = requestOwner(request);
    const org = requestOrg(request, this.env);
    const leaseScope = requestLeaseAuth(request);
    return this.filterLeases(leases, request).filter((lease) => {
      if (lease.owner !== owner || lease.org !== org) {
        return false;
      }
      return !leaseScope || leaseScope === lease.id;
    });
  }

  private leaseVisibleToRequest(lease: LeaseRecord, request: Request, admin: boolean): boolean {
    if (admin) {
      return true;
    }
    if (lease.org !== requestOrg(request, this.env)) {
      return false;
    }
    const ownerMatch = lease.owner === requestOwner(request);
    const payerMatch = Boolean(lease.payer) && lease.payer === requestPayer(request).toLowerCase();
    if (!ownerMatch && !payerMatch) {
      return false;
    }
    const leaseScope = requestLeaseAuth(request);
    return !leaseScope || leaseScope === lease.id;
  }

  private runVisibleToRequest(run: RunRecord, request: Request): boolean {
    if (isAdminRequest(request)) {
      return true;
    }
    if (run.owner !== requestOwner(request) || run.org !== requestOrg(request, this.env)) {
      return false;
    }
    const leaseScope = requestLeaseAuth(request);
    return !leaseScope || leaseScope === run.leaseID;
  }

  private async putLease(lease: LeaseRecord): Promise<void> {
    await this.state.storage.put(leaseKey(lease.id), lease);
  }

  private async promotedImage(
    provider: Provider,
    tag: string,
  ): Promise<PromotedImageRecord | undefined> {
    return this.state.storage.get<PromotedImageRecord>(promotedImageKey(provider, tag));
  }

  private async getRun(runID: string): Promise<RunRecord | undefined> {
    return this.state.storage.get<RunRecord>(runKey(runID));
  }

  private async putRun(run: RunRecord): Promise<void> {
    await this.state.storage.put(runKey(run.id), run);
  }

  private async appendRunEventRecord(
    run: RunRecord,
    input: RunEventRequest,
  ): Promise<RunEventRecord> {
    const now = new Date().toISOString();
    const seq = (run.eventCount ?? 0) + 1;
    const event = boundedRunEvent(run.id, seq, now, input);
    applyRunEventSummary(run, event);
    run.eventCount = seq;
    run.lastEventAt = now;
    await this.state.storage.put(runEventKey(run.id, seq), event);
    await this.putRun(run);
    return event;
  }

  private provider(provider: Provider, region = "eu-west-1"): CloudProvider {
    const testProvider = this.testProviders[provider];
    if (testProvider) {
      return testProvider;
    }
    if (provider === "aws") {
      return new AWSProvider(this.env, region || this.env.CRABBOX_AWS_REGION || "eu-west-1");
    }
    return new HetznerProvider(this.env);
  }

  private async deleteLeaseServer(lease: LeaseRecord): Promise<void> {
    if (lease.provider === "aws") {
      await this.provider("aws", lease.region).deleteServer(lease.cloudID);
      if (validCrabboxProviderKey(lease.providerKey)) {
        await this.provider("aws", lease.region).deleteSSHKey(lease.providerKey);
      }
      return;
    }
    await this.provider("hetzner").deleteServer(String(lease.serverID));
    if (validCrabboxProviderKey(lease.providerKey)) {
      await this.provider("hetzner").deleteSSHKey(lease.providerKey);
    }
  }
}

function leaseKey(leaseID: string): string {
  return `lease:${leaseID}`;
}

function runKey(runID: string): string {
  return `run:${runID}`;
}

function runLogKey(runID: string): string {
  return `runlog:${runID}`;
}

function runLogChunkPrefix(runID: string): string {
  return `runlog:${runID}:chunk:`;
}

function runLogChunkKey(runID: string, index: number): string {
  return `${runLogChunkPrefix(runID)}${String(index).padStart(6, "0")}`;
}

function runEventPrefix(runID: string): string {
  return `runevent:${runID}:`;
}

function runEventKey(runID: string, seq: number): string {
  return `${runEventPrefix(runID)}${String(seq).padStart(12, "0")}`;
}

function promotedImageKey(provider: Provider, tag: string): string {
  return `image:${provider}:promoted:${tag}`;
}

function normalizeTag(tag: string | undefined): string {
  const trimmed = (tag ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(trimmed) ? trimmed : "latest";
}

function newLeaseID(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `cbx_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function newRunID(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `run_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function validLeaseID(value: string | undefined): value is string {
  return typeof value === "string" && /^cbx_[a-f0-9]{12}$/.test(value);
}

function validImageID(value: string | undefined): value is string {
  if (typeof value !== "string") {
    return false;
  }
  return /^ami-[a-f0-9]{8,32}$/.test(value) || /^[1-9][0-9]{0,18}$/.test(value);
}

function validImageName(value: string): boolean {
  return /^[A-Za-z0-9()[\]./_ -]{3,128}$/.test(value);
}

function validCrabboxProviderKey(value: string | undefined): value is string {
  return typeof value === "string" && /^crabbox-cbx-[a-f0-9]{12}$/.test(value);
}

function clampLimit(value: string | null, fallback: number): number {
  const parsed = Number(value ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(parsed), 500);
}

function notFound(): Response {
  return json({ error: "not_found" }, { status: 404 });
}

function requestSourceCIDRs(request: Request): string[] {
  const sourceIP = request.headers.get("cf-connecting-ip") ?? "";
  if (!sourceIP) {
    return [];
  }
  const cidr = sourceIP.includes(":") ? `${sourceIP}/128` : `${sourceIP}/32`;
  return validCIDRs([cidr]);
}

function finiteNumber(value: number | undefined): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

function finiteQueryNumber(value: string | null): number | undefined {
  const parsed = Number(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : undefined;
}

function normalizeRunLogInput(input: RunFinishRequest): {
  log: string;
  bytes: number;
  truncated: boolean;
} {
  const chunkLog = Array.isArray(input.logChunks)
    ? input.logChunks.map((chunk) => String(chunk)).join("")
    : "";
  const rawLog = chunkLog || input.log || "";
  const bounded = truncateUtf8Tail(rawLog, maxStoredRunLogBytes);
  const rawBytes = textEncoder.encode(rawLog).byteLength;
  return {
    log: bounded,
    bytes: Math.min(rawBytes, maxStoredRunLogBytes),
    truncated: Boolean(input.logTruncated) || rawBytes > maxStoredRunLogBytes,
  };
}

function splitRunLogByBytes(log: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of log) {
    const charBytes = textEncoder.encode(char).byteLength;
    if (current && currentBytes + charBytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function truncateUtf8Tail(value: string, maxBytes: number): string {
  const encoded = textEncoder.encode(value);
  if (encoded.byteLength <= maxBytes) {
    return value;
  }
  return textDecoder.decode(encoded.slice(encoded.byteLength - maxBytes));
}

const MAX_RESULT_FILES = 50;
const MAX_RESULT_FAILURES = 100;
const MAX_RESULT_STRING_BYTES = 4096;
const MAX_EVENT_STRING_BYTES = 16 * 1024;

function boundedRunEvent(
  runID: string,
  seq: number,
  createdAt: string,
  input: RunEventRequest,
): RunEventRecord {
  const type = input.type && input.type.trim() ? input.type.trim() : "event";
  const event: RunEventRecord = {
    runID,
    seq,
    type: truncateString(type, 128),
    createdAt,
  };
  if (input.phase) {
    event.phase = truncateString(input.phase, 128);
  }
  if (input.stream === "stdout" || input.stream === "stderr") {
    event.stream = input.stream;
  }
  if (input.message) {
    event.message = truncateString(input.message, MAX_EVENT_STRING_BYTES);
  }
  if (input.data) {
    event.data = truncateString(input.data, MAX_EVENT_STRING_BYTES);
  }
  if (input.leaseID && validLeaseID(input.leaseID)) {
    event.leaseID = input.leaseID;
  }
  if (input.slug) {
    event.slug = truncateString(input.slug, 128);
  }
  if (input.provider === "aws" || input.provider === "hetzner") {
    event.provider = input.provider;
  }
  if (input.class) {
    event.class = truncateString(input.class, 128);
  }
  if (input.serverType) {
    event.serverType = truncateString(input.serverType, 128);
  }
  const exitCode = input.exitCode;
  if (typeof exitCode === "number" && Number.isFinite(exitCode)) {
    event.exitCode = exitCode;
  }
  return event;
}

function applyRunEventSummary(run: RunRecord, event: RunEventRecord): void {
  if (event.phase) {
    run.phase = event.phase;
  } else {
    const phase = phaseForRunEvent(event);
    if (phase) {
      run.phase = phase;
    }
  }
  if (event.leaseID) {
    run.leaseID = event.leaseID;
  }
  if (event.slug) {
    run.slug = event.slug;
  }
  if (event.provider) {
    run.provider = event.provider;
  }
  if (event.class) {
    run.class = event.class;
  }
  if (event.serverType) {
    run.serverType = event.serverType;
  }
  if (event.type === "run.failed") {
    run.state = "failed";
    run.phase = "failed";
    run.endedAt = event.createdAt;
  }
}

function phaseForRunEvent(event: RunEventRecord): string {
  switch (event.type) {
    case "leasing.started":
      return "leasing";
    case "lease.created":
      return "leased";
    case "bootstrap.waiting":
      return "bootstrap";
    case "sync.started":
      return "sync";
    case "sync.finished":
      return "synced";
    case "command.started":
    case "stdout":
    case "stderr":
      return "command";
    case "lease.released":
      return "released";
    default:
      return "";
  }
}

function boundedTestResults(results: TestResultSummary): TestResultSummary {
  return {
    ...results,
    files: results.files
      .slice(0, MAX_RESULT_FILES)
      .map((file) => truncateString(file, MAX_RESULT_STRING_BYTES)),
    failed: results.failed.slice(0, MAX_RESULT_FAILURES).map(boundedTestFailure),
  };
}

function boundedTestFailure(failure: TestFailure): TestFailure {
  const out: TestFailure = {
    suite: truncateString(failure.suite, MAX_RESULT_STRING_BYTES),
    name: truncateString(failure.name, MAX_RESULT_STRING_BYTES),
    kind: failure.kind,
  };
  if (failure.classname) {
    out.classname = truncateString(failure.classname, MAX_RESULT_STRING_BYTES);
  }
  if (failure.file) {
    out.file = truncateString(failure.file, MAX_RESULT_STRING_BYTES);
  }
  if (failure.message) {
    out.message = truncateString(failure.message, MAX_RESULT_STRING_BYTES);
  }
  if (failure.type) {
    out.type = truncateString(failure.type, MAX_RESULT_STRING_BYTES);
  }
  return out;
}

function truncateString(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  const decoder = new TextDecoder();
  let out = decoder.decode(bytes.slice(0, maxBytes));
  while (encoder.encode(out).byteLength > maxBytes) {
    out = out.slice(0, -1);
  }
  return out;
}

function leaseTTLSeconds(lease: LeaseRecord): number {
  if (Number.isFinite(lease.ttlSeconds) && lease.ttlSeconds > 0) {
    return lease.ttlSeconds;
  }
  const createdAt = Date.parse(lease.createdAt);
  const expiresAt = Date.parse(lease.expiresAt);
  if (Number.isFinite(createdAt) && Number.isFinite(expiresAt) && expiresAt > createdAt) {
    return Math.min(Math.trunc((expiresAt - createdAt) / 1000), 86_400);
  }
  return 5_400;
}

function leaseIdleTimeoutSeconds(lease: LeaseRecord): number {
  if (
    Number.isFinite(lease.idleTimeoutSeconds) &&
    lease.idleTimeoutSeconds &&
    lease.idleTimeoutSeconds > 0
  ) {
    return lease.idleTimeoutSeconds;
  }
  return leaseTTLSeconds(lease);
}

function recomputeLeaseExpiresAt(lease: LeaseRecord, fallbackNow: Date): Date {
  const createdAt = parseLeaseDate(lease.createdAt, fallbackNow);
  const touchedAt = parseLeaseDate(lease.lastTouchedAt, createdAt);
  return leaseExpiresAt(
    createdAt,
    touchedAt,
    leaseTTLSeconds(lease),
    leaseIdleTimeoutSeconds(lease),
  );
}

function leaseExpiresAt(
  createdAt: Date,
  lastTouchedAt: Date,
  ttlSeconds: number,
  idleTimeoutSeconds: number,
): Date {
  const maxLifetime = createdAt.getTime() + Math.max(1, ttlSeconds) * 1000;
  const idleExpiry = lastTouchedAt.getTime() + Math.max(1, idleTimeoutSeconds) * 1000;
  return new Date(Math.min(maxLifetime, idleExpiry));
}

function parseLeaseDate(value: string | undefined, fallback: Date): Date {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? new Date(parsed) : fallback;
}

function clampLeaseSeconds(value: number | undefined, max: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return max;
  }
  return Math.min(Math.trunc(value), max);
}

function allocateLeaseSlug(
  requested: string,
  leaseID: string,
  owner: string,
  org: string,
  leases: LeaseRecord[],
): string {
  let slug = normalizeLeaseSlug(requested) || leaseSlugFromID(leaseID);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!activeSlugCollision(slug, owner, org, leases)) {
      return slug;
    }
    slug = slugWithCollisionSuffix(requested, `${leaseID}-${attempt}`);
  }
  throw new Error(`could not allocate slug for ${leaseID}`);
}

function activeSlugCollision(
  slug: string,
  owner: string,
  org: string,
  leases: LeaseRecord[],
): boolean {
  const now = Date.now();
  return leases.some(
    (lease) =>
      lease.state === "active" &&
      Date.parse(lease.expiresAt) > now &&
      lease.owner === owner &&
      lease.org === org &&
      normalizeLeaseSlug(lease.slug) === slug,
  );
}

async function optionalJson<T>(request: Request): Promise<T> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return {} as T;
  }
  return readJson<T>(request);
}

function requestedSpendingLimitUSD(input: LeaseRequest, fallbackUSD: number): number {
  const wireInput = input as Record<string, unknown>;
  const requested =
    finiteNumber(input.spendingLimitUSD) ??
    finiteNumber(input.allowanceUSD) ??
    finiteNumber(Number(wireInput["spending_limit"])) ??
    finiteNumber(Number(wireInput["spending_limit_usd"]));
  if (requested !== undefined && requested > 0) {
    return Math.min(roundMoney(requested), 10_000);
  }
  return Math.max(roundMoney(fallbackUSD), 0.01);
}

function twoMinuteBufferUSD(burnRateUSDPerMinute: number): number {
  if (!Number.isFinite(burnRateUSDPerMinute) || burnRateUSDPerMinute <= 0) {
    return 0.01;
  }
  return Math.max(roundMoney(burnRateUSDPerMinute * 2), 0.000001);
}

function voucherRequiredUSD(lease: LeaseRecord, now: Date): number {
  const started = Date.parse(lease.billingStartedAt ?? lease.createdAt);
  const burn = lease.burnRateUSDPerMinute ?? (lease.estimatedHourlyUSD ?? 0) / 60;
  if (!Number.isFinite(started) || !Number.isFinite(burn) || burn <= 0) {
    return 0;
  }
  const elapsedMinutes = Math.max(0, now.getTime() - started) / 60_000;
  return roundMoney(elapsedMinutes * burn);
}

function paymentCoveredUntil(lease: LeaseRecord, fallbackNow: Date): Date {
  const started = Date.parse(lease.billingStartedAt ?? lease.createdAt);
  const burn = lease.burnRateUSDPerMinute ?? (lease.estimatedHourlyUSD ?? 0) / 60;
  const held = lease.highestVoucherHeldUSD ?? 0;
  if (!Number.isFinite(started) || !Number.isFinite(burn) || burn <= 0 || held <= 0) {
    return fallbackNow;
  }
  return new Date(started + (held / burn) * 60_000);
}

function applyAcceptedSession(lease: LeaseRecord, accepted: SessionAcceptance): void {
  lease.sessionID = accepted.channelID;
  lease.highestVoucherHeldUnits = accepted.cumulativeAmountUnits;
  lease.highestVoucherHeldUSD = accepted.cumulativeAmountUSD;
  if (accepted.sessionKey) {
    lease.sessionKey = accepted.sessionKey;
  }
  if (accepted.payer) {
    lease.payer = accepted.payer;
  }
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CloudProvider {
  listCrabboxServers(): Promise<ProviderMachine[]>;
  createServerWithFallback(
    config: ReturnType<typeof leaseConfig>,
    leaseID: string,
    slug: string,
    owner: string,
  ): Promise<{ server: ProviderMachine; serverType: string; attempts?: ProvisioningAttempt[] }>;
  deleteServer(id: string): Promise<void>;
  createImage(instanceID: string, name: string, noReboot: boolean): Promise<ProviderImage>;
  getImage(imageID: string): Promise<ProviderImage>;
  deleteSSHKey(name: string): Promise<void>;
  hourlyPriceUSD(
    serverType: string,
    config: ReturnType<typeof leaseConfig>,
  ): Promise<number | undefined>;
}

class HetznerProvider implements CloudProvider {
  private readonly client: HetznerClient;

  constructor(env: Env) {
    this.client = new HetznerClient(env);
  }

  async listCrabboxServers(): Promise<ProviderMachine[]> {
    const servers = await this.client.listCrabboxServers();
    return servers.map((server) => this.client.toMachine(server));
  }

  async createServerWithFallback(
    config: ReturnType<typeof leaseConfig>,
    leaseID: string,
    slug: string,
    owner: string,
  ): Promise<{ server: ProviderMachine; serverType: string; attempts?: ProvisioningAttempt[] }> {
    const { server, serverType } = await this.client.createServerWithFallback(
      config,
      leaseID,
      slug,
      owner,
    );
    return { server: this.client.toMachine(server), serverType };
  }

  async deleteServer(id: string): Promise<void> {
    await this.client.deleteServer(Number(id));
  }

  createImage(serverID: string, name: string): Promise<ProviderImage> {
    return this.client.createImage(Number(serverID), name);
  }

  getImage(imageID: string): Promise<ProviderImage> {
    return this.client.getImage(imageID);
  }

  async deleteSSHKey(name: string): Promise<void> {
    await this.client.deleteSSHKey(name);
  }

  hourlyPriceUSD(
    serverType: string,
    config: ReturnType<typeof leaseConfig>,
  ): Promise<number | undefined> {
    return this.client.hourlyPriceUSD(serverType, config.location);
  }
}

class AWSProvider implements CloudProvider {
  private readonly client: EC2SpotClient;

  constructor(env: Env, region: string) {
    this.client = new EC2SpotClient(env, region);
  }

  listCrabboxServers(): Promise<ProviderMachine[]> {
    return this.client.listCrabboxServers();
  }

  async createServerWithFallback(
    config: ReturnType<typeof leaseConfig>,
    leaseID: string,
    slug: string,
    owner: string,
  ): Promise<{ server: ProviderMachine; serverType: string; attempts?: ProvisioningAttempt[] }> {
    const { server, serverType, attempts } = await this.client.createServerWithFallback(
      config,
      leaseID,
      slug,
      owner,
    );
    const result: {
      server: ProviderMachine;
      serverType: string;
      attempts?: ProvisioningAttempt[];
    } = { server: await this.client.waitForServerIP(server.cloudID), serverType };
    if (attempts && attempts.length > 0) {
      result.attempts = attempts;
    }
    return result;
  }

  async deleteServer(id: string): Promise<void> {
    await this.client.deleteServer(id);
  }

  createImage(instanceID: string, name: string, noReboot: boolean): Promise<ProviderImage> {
    return this.client.createImage(instanceID, name, noReboot);
  }

  getImage(imageID: string): Promise<ProviderImage> {
    return this.client.getImage(imageID);
  }

  async deleteSSHKey(name: string): Promise<void> {
    await this.client.deleteSSHKey(name);
  }

  hourlyPriceUSD(serverType: string): Promise<number | undefined> {
    return this.client.hourlySpotPriceUSD(serverType);
  }
}
