import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Request } from "express";
import { z } from "zod";

const ENV_PATH = path.resolve(process.cwd(), ".env");
const ENV_TEMP_PATH = path.resolve(process.cwd(), ".env.tmp");
const SUPPORTED_KEYS = [
  "YOUTUBE_API_KEYS",
  "YOUTUBE_API_KEY",
] as const;

type SupportedKey = (typeof SUPPORTED_KEYS)[number];

export interface ApiKeySettings {
  youtubeApiKey?: string;
  /** New multi-key input: raw textarea (one per line / comma-separated) or array of keys. */
  youtubeApiKeys?: string | string[];
}

export const apiKeySettingsSchema = z.object({
  youtubeApiKey: z.string().trim().min(8).max(512).optional(),
  youtubeApiKeys: z.union([
    z.string().max(8192),
    z.array(z.string().max(512)).max(25),
  ]).optional(),
}).strict();

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1"
    || address === "::1"
    || address.startsWith("::ffff:127.");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export interface LocalSettingsRequestMetadata {
  remoteAddress?: string;
  host?: string;
  origin?: string;
  forwarded?: string;
  xForwardedFor?: string;
  xForwardedHost?: string;
  xForwardedProto?: string;
  via?: string;
  secFetchSite?: string;
}

export function isTrustedLocalSettingsMetadata(input: LocalSettingsRequestMetadata): boolean {
  if (!isLoopbackAddress(input.remoteAddress)) return false;
  if (
    input.forwarded
    || input.xForwardedFor
    || input.xForwardedHost
    || input.xForwardedProto
    || input.via
  ) return false;

  if (!input.host) return false;
  if (/[@/\\s%]/.test(input.host)) return false;
  let hostUrl: URL;
  try {
    hostUrl = new URL(`http://${input.host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;

  if (input.origin) {
    try {
      const origin = new URL(input.origin);
      if (
        !["http:", "https:"].includes(origin.protocol)
        || !isLoopbackHostname(origin.hostname)
        || origin.host !== hostUrl.host
      ) return false;
    } catch {
      return false;
    }
  }

  return !input.secFetchSite || input.secFetchSite === "same-origin" || input.secFetchSite === "none";
}

export function isLocalSettingsRequest(req: Request): boolean {
  return isTrustedLocalSettingsMetadata({
    remoteAddress: req.socket.remoteAddress,
    host: req.get("host"),
    origin: req.get("origin"),
    forwarded: req.get("forwarded"),
    xForwardedFor: req.get("x-forwarded-for"),
    xForwardedHost: req.get("x-forwarded-host"),
    xForwardedProto: req.get("x-forwarded-proto"),
    via: req.get("via"),
    secFetchSite: req.get("sec-fetch-site"),
  });
}

// ---------------------------------------------------------------------------
// Multi-key helpers — mirrors server/youtube.ts getYouTubeApiKeys() without
// importing it (avoids circular / DB dependency). YOUTUBE_API_KEYS is
// authoritative (comma-separated, order = rotation order); YOUTUBE_API_KEY
// is kept as single-key fallback for backward compatibility.
// ---------------------------------------------------------------------------

export function getYouTubeApiKeysFromEnv(): string[] {
  const raw = process.env.YOUTUBE_API_KEYS;
  if (raw !== undefined) {
    const trimmed = raw.trim();
    const unwrapped = trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"'
      ? trimmed.slice(1, -1)
      : trimmed;
    const multi = unwrapped.split(",").map((s) => s.trim()).filter(Boolean);
    if (multi.length > 0) return multi;
  }
  const singleRaw = process.env.YOUTUBE_API_KEY?.trim();
  const singleTrimmed = singleRaw !== undefined
    ? (singleRaw.length >= 2 && singleRaw[0] === '"' && singleRaw[singleRaw.length - 1] === '"'
      ? singleRaw.slice(1, -1).trim()
      : singleRaw)
    : undefined;
  if (singleTrimmed) return [singleTrimmed];
  return [];
}

export function getApiKeyStatus() {
  const keys = getYouTubeApiKeysFromEnv();
  return {
    youtube: keys.length > 0,
    youtubeKeyCount: keys.length,
  };
}

function validateApiKey(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length < 8 || trimmed.length > 512) {
    throw new Error(`${label} must be between 8 and 512 characters.`);
  }
  if (/\r|\n|\0/.test(trimmed)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return trimmed;
}

function parseYouTubeKeysInput(value: string | string[]): string[] {
  const rawParts: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string") {
        throw new Error("YouTube API keys must be strings.");
      }
      // Each array entry may itself contain commas/newlines (paste variance)
      rawParts.push(...entry.split(/[,\n]+/));
    }
  } else {
    rawParts.push(...value.split(/[,\n]+/));
  }
  return rawParts.map((s) => s.trim()).filter(Boolean);
}

function validateYouTubeKeys(keys: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const raw = keys[i]!;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.length < 8 || trimmed.length > 512) {
      throw new Error(`YouTube API key ${i + 1} must be between 8 and 512 characters.`);
    }
    if (/\r|\n|\0/.test(trimmed)) {
      throw new Error(`YouTube API key ${i + 1} contains unsupported characters.`);
    }
    out.push(trimmed);
  }
  return out;
}

function setEnvValue(contents: string, key: SupportedKey, value: string): string {
  const assignment = `${key}=${JSON.stringify(value)}`;
  const lines = contents.split(/\r?\n/);
  const lineIndex = lines.findIndex((line) => line.startsWith(`${key}=`));

  if (lineIndex >= 0) {
    lines[lineIndex] = assignment;
  } else {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
    lines.push(assignment);
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export async function saveApiKeySettings(input: ApiKeySettings) {
  // Accept either the new multi-key field or the legacy single-key field.
  // youtubeApiKeys takes precedence when both are supplied.
  let keys: string[] | undefined;

  if (input.youtubeApiKeys !== undefined) {
    const raw = input.youtubeApiKeys;
    if (typeof raw !== "string" && !Array.isArray(raw)) {
      throw new Error("YouTube API keys must be a string or array of strings.");
    }
    const parsed = parseYouTubeKeysInput(raw as string | string[]);
    const validated = validateYouTubeKeys(parsed);
    if (validated.length > 0) keys = validated;
  }

  if (!keys && input.youtubeApiKey !== undefined) {
    const single = validateApiKey(input.youtubeApiKey, "YouTube API key");
    if (single) keys = [single];
  }

  if (!keys || keys.length === 0) {
    throw new Error("Enter at least one replacement YouTube API key to save.");
  }

  if (keys.length > 25) {
    throw new Error("Too many YouTube API keys (max 25).");
  }

  // Deduplicate preserving order (rotation order = list order)
  const deduped = Array.from(new Set(keys));
  const storedValue = deduped.join(",");

  let contents = "";
  try {
    contents = await readFile(ENV_PATH, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  contents = setEnvValue(contents, "YOUTUBE_API_KEYS", storedValue);

  await writeFile(ENV_TEMP_PATH, contents, { encoding: "utf8", mode: 0o600 });
  await rename(ENV_TEMP_PATH, ENV_PATH);
  await chmod(ENV_PATH, 0o600);

  process.env.YOUTUBE_API_KEYS = storedValue;
  // Keep process.env.YOUTUBE_API_KEY in sync for legacy readers that still
  // check the single-key var directly (e.g. server/youtube.ts fallback).
  // The persisted .env source of truth is YOUTUBE_API_KEYS; YOUTUBE_API_KEY
  // in .env is left untouched to avoid surprising file churn for users who
  // still have it.
  if (!process.env.YOUTUBE_API_KEY?.trim()) {
    process.env.YOUTUBE_API_KEY = deduped[0]!;
  }

  return getApiKeyStatus();
}
