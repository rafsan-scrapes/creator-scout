import { z } from "zod";

export enum UploadDateFilter {
  ANY = "any",
  HOUR = "hour",
  TODAY = "today",
  WEEK = "week",
  MONTH = "month",
  YEAR = "year"
}

export enum DurationFilter {
  ANY = "any",
  SHORT = "short",
  MEDIUM = "medium",
  LONG = "long"
}

export enum SortBy {
  RELEVANCE = "relevance",
  DATE = "date",
  VIEW_COUNT = "viewCount",
  RATING = "rating"
}

export const videoSchema = z.object({
  id: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(500),
  channelTitle: z.string().trim().min(1).max(200),
  channelId: z.string().trim().min(1).max(128),
  publishedAt: z.string().trim().min(1).max(64),
  thumbnailUrl: z.string().url().max(2_048),
  description: z.string().max(10_000),
  viewCount: z.number().optional(),
  likeCount: z.number().optional(),
  commentCount: z.number().optional(),
  duration: z.string().trim().max(64).optional(),
  tags: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  categoryId: z.string().trim().max(32).optional(),
  liveBroadcastContent: z.string().trim().max(32).optional(),
  defaultLanguage: z.string().trim().max(35).optional(),
  defaultAudioLanguage: z.string().trim().max(35).optional(),
  definition: z.string().trim().max(16).optional(),
  hasCaptions: z.boolean().optional(),
  licensedContent: z.boolean().optional(),
  embeddable: z.boolean().optional(),
  madeForKids: z.boolean().optional(),
  hasPaidProductPlacement: z.boolean().optional(),
  topicCategories: z.array(z.string().url().max(2_048)).max(20).optional(),
  liveStreamingDetails: z.object({
    actualStartTime: z.string().trim().max(64).optional(),
    actualEndTime: z.string().trim().max(64).optional(),
    scheduledStartTime: z.string().trim().max(64).optional(),
    concurrentViewers: z.number().optional(),
  }).optional(),
  channelStatistics: z.object({
    subscriberCount: z.number().optional(),
    hiddenSubscriberCount: z.boolean(),
    videoCount: z.number().optional(),
    viewCount: z.number().optional(),
    publishedAt: z.string().trim().max(64).optional(),
    country: z.string().trim().max(8).optional(),
    thumbnailUrl: z.string().url().max(2_048).optional(),
    description: z.string().max(5_000).optional(),
    customUrl: z.string().trim().max(200).optional(),
    defaultLanguage: z.string().trim().max(35).optional(),
    keywords: z.string().max(1_000).optional(),
    topicCategories: z.array(z.string().url().max(2_048)).max(20).optional(),
  }).optional(),
}).strict();

export type Video = z.infer<typeof videoSchema>;

export const searchFiltersSchema = z.object({
  query: z.string().trim().min(1).max(200),
  uploadDate: z.nativeEnum(UploadDateFilter).default(UploadDateFilter.ANY),
  duration: z.nativeEnum(DurationFilter).default(DurationFilter.ANY),
  sortBy: z.nativeEnum(SortBy).default(SortBy.RELEVANCE),
  maxResults: z.number().min(1).max(50).default(25),
});

export type SearchFilters = z.infer<typeof searchFiltersSchema>;

export const providerErrorCategorySchema = z.enum([
  "missing_key",
  "invalid_key",
  "quota",
  "timeout",
  "network",
  "provider_server",
  "invalid_response",
  "unknown",
]);

export type ProviderErrorCategory = z.infer<typeof providerErrorCategorySchema>;

export const providerErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string(),
  category: providerErrorCategorySchema,
  retryable: z.boolean(),
  suggestion: z.string(),
});

export type ProviderErrorResponse = z.infer<typeof providerErrorResponseSchema>;

export const researchWarningSchema = z.object({
  code: z.string().trim().min(1).max(128),
  stage: z.enum(["search", "video_details", "channel_enrichment"]),
  message: z.string().trim().min(1).max(1_000),
}).strict();

export type ResearchWarning = z.infer<typeof researchWarningSchema>;

export const enrichmentStageSchema = z.object({
  status: z.enum(["complete", "partial", "skipped"]),
  requested: z.number().int().min(0).max(50),
  returned: z.number().int().min(0).max(50),
}).strict();

export const searchProvenanceSchema = z.object({
  provider: z.literal("youtube-data-api-v3"),
  query: z.string().trim().min(1).max(200),
  filters: z.object({
    uploadDate: z.nativeEnum(UploadDateFilter),
    duration: z.nativeEnum(DurationFilter),
    sortBy: z.nativeEnum(SortBy),
    maxResults: z.number().int().min(1).max(50),
  }),
  orderedVideoIds: z.array(z.string().trim().min(1).max(128)).max(50),
}).strict();

export type SearchProvenance = z.infer<typeof searchProvenanceSchema>;

export const searchResponseSchema = z.object({
  videos: z.array(videoSchema),
  totalResults: z.number(),
  nextPageToken: z.string().optional(),
  resultsPerPage: z.number().optional(),
  regionCode: z.string().optional(),
  snapshotId: z.string().min(8).max(128),
  retrievedAt: z.string().datetime(),
  totalResultsIsApproximate: z.boolean(),
  provenance: searchProvenanceSchema,
  enrichment: z.object({
    search: enrichmentStageSchema,
    videoDetails: enrichmentStageSchema,
    channels: enrichmentStageSchema,
  }),
  warnings: z.array(researchWarningSchema),
});

export type SearchResponse = z.infer<typeof searchResponseSchema>;
