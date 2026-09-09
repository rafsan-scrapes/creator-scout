import type { Express } from "express";
import { createServer, type Server } from "http";
import { runScoutDiscovery } from "./youtube";
import { manualAddRequestSchema, scoutRequestSchema } from "@shared/schema";
import { z } from "zod";
import { apiKeySettingsSchema, getApiKeyStatus, isLocalSettingsRequest, saveApiKeySettings } from "./settings";
import { normalizeProviderError, providerErrorPayload } from "./provider-errors";
import { createRateLimiter } from "./rate-limit";
import { addManualChannel, getChannel, isChannelKnown, listHistory } from "./db";
import { ChannelResolveError, resolveChannelIdentifier } from "./channel-resolver";

const { middleware: scoutRateLimit } = createRateLimiter({ maxRequests: 10, windowMs: 60_000 });
// Same budget as POST /api/scout — a manual add is a real YouTube API call too.
const { middleware: manualAddRateLimit } = createRateLimiter({ maxRequests: 10, windowMs: 60_000 });

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.get("/api/settings/status", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!isLocalSettingsRequest(req)) {
      return res.status(403).json({ error: "Settings are available only from this machine." });
    }
    return res.json(getApiKeyStatus());
  });

  app.put("/api/settings/api-keys", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!isLocalSettingsRequest(req)) {
      return res.status(403).json({ error: "Settings are available only from this machine." });
    }

    try {
      const input = apiKeySettingsSchema.parse(req.body);
      const status = await saveApiKeySettings(input);
      return res.json({ success: true, status });
    } catch (error: any) {
      return res.status(400).json({
        error: error?.message || "Unable to save API settings.",
      });
    }
  });

  // Step 1: No Insights/Ideas/Script/Thumbnail routes remain — Phase 1 strip-down confirmed.

  // Step 2: Scout discovery — single synchronous response (Phase 4 step 3 defers to single response).
  app.post("/api/scout", scoutRateLimit, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const parsed = scoutRequestSchema.parse(req.body);

      const normalizedKeywords = Array.from(
        new Set(parsed.keywords.map((k) => k.trim()).filter(Boolean)),
      );
      if (normalizedKeywords.length === 0) {
        return res.status(400).json({ error: "At least one keyword is required." });
      }

      const result = await runScoutDiscovery({
        keywords: normalizedKeywords,
        filters: {
          minSubscribers: parsed.minSubscribers,
          maxSubscribers: parsed.maxSubscribers,
          maxDaysSinceUpload: parsed.maxDaysSinceUpload,
          minAvgViews: parsed.minAvgViews,
          minEngagementRate: parsed.minEngagementRate,
        },
        targetCount: parsed.targetCount,
      });

      return res.json({
        channels: result.qualifiedChannels,
        stopReason: result.stopReason,
        found: result.found,
        requested: result.requested,
        keywordsSearched: result.keywordsSearched,
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid scout parameters", details: error.errors });
      }
      console.error("Scout error:", error);
      const providerError = normalizeProviderError(error, "youtube");
      // quota_exhausted is not an error — runScoutDiscovery never throws quota (returns partial).
      // Any quota error reaching here is an unexpected path, but still return a provider payload.
      return res.status(providerError.status).json(providerErrorPayload(providerError, "YouTube Data API"));
    }
  });


  // Phase 8 step 7 — History tab table read. No rate limiter: this is a
  // local DB read with no YouTube API cost. no-store: the exclusion list
  // is live, mutable state (same reasoning as Phase 6.1 W5).
  app.get("/api/history", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    return res.json({ channels: listHistory() });
  });

  // Phase 8 step 6 — manual add to the exclusion-list history.
  // Body { input: string }. Every outcome carries a `status` discriminator
  // for the History tab client: added | already-in-history | invalid-input |
  // channel-not-found | quota-exhausted | provider-error.
  app.post("/api/history/manual-add", manualAddRateLimit, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const parsed = manualAddRequestSchema.parse(req.body);

      const resolution = await resolveChannelIdentifier(parsed.input);
      if (resolution.status === "already-in-history") {
        return res.status(409).json({
          status: "already-in-history",
          error: "This channel is already in your history.",
        });
      }

      // Re-check after resolution: handle/username/custom-URL IDs weren't
      // knowable up front, so they skip the resolver's early exit.
      const { channel } = resolution;
      if (isChannelKnown(channel.channelId)) {
        return res.status(409).json({
          status: "already-in-history",
          error: "This channel is already in your history.",
        });
      }

      // Belt-and-braces: addManualChannel itself no-ops on duplicates.
      const outcome = addManualChannel(channel.channelId, channel.channelUrl, channel.channelName);
      if (outcome === "already exists") {
        return res.status(409).json({
          status: "already-in-history",
          error: "This channel is already in your history.",
        });
      }

      const record = getChannel(channel.channelId);
      return res.status(201).json({
        status: "added",
        channel: record ?? {
          channel_id: channel.channelId,
          channel_url: channel.channelUrl,
          channel_name: channel.channelName,
          source: "manual",
          matched_keyword: null,
          added_at: new Date().toISOString(),
        },
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ status: "invalid-input", error: "Enter a channel link, @handle, or channel ID.", details: error.errors });
      }
      if (error instanceof ChannelResolveError) {
        if (error.code === "invalid-input") {
          return res.status(400).json({ status: "invalid-input", error: error.message });
        }
        return res.status(404).json({ status: "channel-not-found", error: error.message });
      }
      console.error("Manual-add error:", error);
      const providerError = normalizeProviderError(error, "youtube");
      const payload = providerErrorPayload(providerError, "YouTube Data API");
      return res.status(providerError.status).json({
        status: providerError.category === "quota" ? "quota-exhausted" : "provider-error",
        ...payload,
      });
    }
  });


  return httpServer;
}
