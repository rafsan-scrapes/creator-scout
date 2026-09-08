import type { Express } from "express";
import { createServer, type Server } from "http";
import { searchVideos } from "./youtube";
import { runScoutDiscovery } from "./youtube";
import { searchFiltersSchema, scoutRequestSchema } from "@shared/schema";
import { z } from "zod";
import { apiKeySettingsSchema, getApiKeyStatus, isLocalSettingsRequest, saveApiKeySettings } from "./settings";
import { normalizeProviderError, providerErrorPayload } from "./provider-errors";
import { createRateLimiter } from "./rate-limit";

const { middleware: rateLimit } = createRateLimiter();
const { middleware: scoutRateLimit } = createRateLimiter({ maxRequests: 10, windowMs: 60_000 });

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

  app.get("/api/youtube/search", rateLimit, async (req, res) => {
    try {
      const { query, uploadDate, duration, sortBy, maxResults } = req.query;

      if (!query || typeof query !== "string") {
        return res.status(400).json({ error: "Query parameter is required" });
      }

      const filters = searchFiltersSchema.parse({
        query,
        uploadDate: uploadDate || "any",
        duration: duration || "any",
        sortBy: sortBy || "relevance",
        maxResults: maxResults ? parseInt(maxResults as string, 10) : 25,
      });

      const result = await searchVideos(filters);
      res.json(result);
    } catch (error: any) {
      console.error("YouTube search error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid search parameters", details: error.errors });
      }
      const providerError = normalizeProviderError(error, "youtube");
      res.status(providerError.status).json(providerErrorPayload(providerError, "YouTube Data API"));
    }
  });

  return httpServer;
}
