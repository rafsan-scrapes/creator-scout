import { useState, useCallback } from "react";
import {
  Search, Loader2, ExternalLink, Users, Eye, Activity,
  Calendar, Target, AlertCircle, CheckCircle2, Clock,
  Hash, Info, Database,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ScoutChannel, ScoutStopReason } from "@shared/schema";
import { SCOUT_KEYWORD_LIMIT } from "@shared/schema";

type ScoutResponse = {
  channels: ScoutChannel[];
  stopReason: ScoutStopReason;
  found: number;
  requested: number;
  keywordsSearched: number;
};

type ApiError = {
  message: string;
  status?: number;
  category?: string;
  suggestion?: string;
};

function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString();
}

function formatEngagement(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${v.toFixed(2)}%`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function stopReasonLabel(reason: ScoutStopReason): { text: string; variant: "default" | "secondary" | "outline" } {
  switch (reason) {
    case "target_reached":
      return { text: "Target reached", variant: "default" };
    case "keywords_exhausted":
      return { text: "All keywords searched", variant: "secondary" };
    case "quota_exhausted":
      return { text: "Quota exhausted — partial results", variant: "outline" };
  }
}

function stopReasonDescription(reason: ScoutStopReason, found: number, requested: number, keywordsSearched: number): string {
  switch (reason) {
    case "target_reached":
      return `Found ${found} of ${requested} requested creators — target reached after searching ${keywordsSearched} keyword${keywordsSearched === 1 ? "" : "s"}.`;
    case "keywords_exhausted":
      return `Found ${found} of ${requested} requested creators — all ${keywordsSearched} keyword${keywordsSearched === 1 ? "" : "s"} searched.`;
    case "quota_exhausted":
      return `Found ${found} of ${requested} requested creators — YouTube quota exhausted after ${keywordsSearched} keyword${keywordsSearched === 1 ? "" : "s"}. This is a normal partial result; add quota or try again after midnight Pacific.`;
  }
}

function parseKeywords(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function ScoutPage() {
  // form state — strings so empty is distinguishable from 0
  const [keywordsText, setKeywordsText] = useState("");
  const [minSubscribers, setMinSubscribers] = useState("1000");
  const [maxSubscribers, setMaxSubscribers] = useState("500000");
  const [maxDaysSinceUpload, setMaxDaysSinceUpload] = useState("30");
  const [minAvgViews, setMinAvgViews] = useState("5000");
  const [minEngagementRate, setMinEngagementRate] = useState("");
  const [targetCount, setTargetCount] = useState("10");

  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<ScoutResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const keywords = parseKeywords(keywordsText);
  const keywordCount = keywords.length;
  const overLimit = keywordCount > SCOUT_KEYWORD_LIMIT;

  const validate = useCallback((): string | null => {
    if (keywordCount === 0) return "Enter at least one keyword (one per line or comma-separated).";
    if (overLimit) return `Too many keywords — limit is ${SCOUT_KEYWORD_LIMIT} (you have ${keywordCount}).`;
    const minSubs = Number(minSubscribers);
    const maxSubs = Number(maxSubscribers);
    const maxDays = Number(maxDaysSinceUpload);
    const minViews = Number(minAvgViews);
    const target = Number(targetCount);
    if (!Number.isFinite(minSubs) || minSubs < 0) return "Minimum subscribers must be 0 or more.";
    if (!Number.isFinite(maxSubs) || maxSubs < 0) return "Maximum subscribers must be 0 or more.";
    if (minSubs > maxSubs) return "Minimum subscribers must be ≤ maximum subscribers.";
    if (!Number.isFinite(maxDays) || maxDays < 1 || maxDays > 3650) return "Max days since upload must be 1–3650.";
    if (!Number.isFinite(minViews) || minViews < 0) return "Minimum average views must be 0 or more.";
    if (!Number.isFinite(target) || target < 1 || target > 500) return "Target count must be 1–500.";
    if (minEngagementRate.trim() !== "") {
      const eng = Number(minEngagementRate);
      if (!Number.isFinite(eng) || eng < 0 || eng > 100) return "Engagement rate must be 0–100 or left blank.";
    }
    return null;
  }, [keywordCount, overLimit, minSubscribers, maxSubscribers, maxDaysSinceUpload, minAvgViews, minEngagementRate, targetCount]);

  const handleRun = useCallback(async () => {
    const v = validate();
    if (v) {
      setValidationError(v);
      return;
    }
    setValidationError(null);
    setError(null);
    setResult(null);
    setIsRunning(true);

    const deduped = Array.from(new Set(keywords));

    const body: Record<string, unknown> = {
      keywords: deduped,
      minSubscribers: Math.floor(Number(minSubscribers)),
      maxSubscribers: Math.floor(Number(maxSubscribers)),
      maxDaysSinceUpload: Math.floor(Number(maxDaysSinceUpload)),
      minAvgViews: Math.floor(Number(minAvgViews)),
      targetCount: Math.floor(Number(targetCount)),
    };
    if (minEngagementRate.trim() !== "") {
      body.minEngagementRate = Number(minEngagementRate);
    }

    try {
      const res = await fetch("/api/scout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });

      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg =
          typeof payload.error === "string"
            ? payload.error
            : typeof payload.message === "string"
              ? payload.message
              : res.statusText || "Scout run failed.";
        const suggestion = typeof payload.suggestion === "string" ? payload.suggestion : undefined;
        const category = typeof payload.category === "string" ? payload.category : undefined;
        setError({ message: msg, status: res.status, category, suggestion });
        return;
      }

      // Normal success — includes quota_exhausted as a normal stopReason, not an error
      const scoutResult = payload as ScoutResponse;
      setResult(scoutResult);
    } catch (e: unknown) {
      const offline = typeof navigator !== "undefined" && !navigator.onLine;
      setError({
        message: e instanceof Error ? e.message : offline ? "You appear to be offline." : "The scout request could not be completed.",
        suggestion: offline ? "Check your connection and retry." : undefined,
      });
    } finally {
      setIsRunning(false);
    }
  }, [validate, keywords, minSubscribers, maxSubscribers, maxDaysSinceUpload, minAvgViews, minEngagementRate, targetCount]);

  const hasResults = result !== null;
  const channels = result?.channels ?? [];

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-6 p-4 lg:p-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 text-primary">
          <Search className="h-5 w-5" />
          <span className="text-sm font-medium">Creator Scout</span>
        </div>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Find creators</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Enter keywords and filters. The scout searches YouTube, skips channels it has seen before, and returns
          qualifying creators — no AI step, no CSV.
        </p>
      </div>

      {/* Form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Target className="h-5 w-5 text-primary" />
            Scout filters
          </CardTitle>
          <CardDescription>
            Keywords match topical relevance via video search. Every evaluated channel is remembered so future runs
            never re-fetch it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Keywords */}
          <div className="space-y-2">
            <Label htmlFor="scout-keywords" className="flex items-center gap-2">
              <Hash className="h-3.5 w-3.5 text-muted-foreground" />
              Keywords
              <span className="text-xs font-normal text-muted-foreground">
                — one per line or comma-separated · {keywordCount}/{SCOUT_KEYWORD_LIMIT}
              </span>
            </Label>
            <Textarea
              id="scout-keywords"
              placeholder={"gaming setup\ncozy desk tour, mechanical keyboard"}
              value={keywordsText}
              onChange={(e) => setKeywordsText(e.target.value)}
              rows={4}
              className="font-mono text-sm"
              data-testid="input-scout-keywords"
              aria-describedby="scout-keywords-hint"
            />
            <p id="scout-keywords-hint" className="text-xs text-muted-foreground">
              Up to {SCOUT_KEYWORD_LIMIT} keywords per run. Parsed as one keyword per line or comma.
              {overLimit && <span className="ml-1 font-medium text-destructive">Over the limit — remove some keywords.</span>}
            </p>
          </div>

          {/* Numeric filters */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="scout-min-subs" className="flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5 text-muted-foreground" />
                Min subscribers
              </Label>
              <Input
                id="scout-min-subs"
                type="number"
                inputMode="numeric"
                min={0}
                max={1000000000}
                step={1}
                value={minSubscribers}
                onChange={(e) => setMinSubscribers(e.target.value)}
                data-testid="input-scout-min-subs"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="scout-max-subs" className="flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5 text-muted-foreground" />
                Max subscribers
              </Label>
              <Input
                id="scout-max-subs"
                type="number"
                inputMode="numeric"
                min={0}
                max={1000000000}
                step={1}
                value={maxSubscribers}
                onChange={(e) => setMaxSubscribers(e.target.value)}
                data-testid="input-scout-max-subs"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="scout-max-days" className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                Max days since last upload
              </Label>
              <Input
                id="scout-max-days"
                type="number"
                inputMode="numeric"
                min={1}
                max={3650}
                step={1}
                value={maxDaysSinceUpload}
                onChange={(e) => setMaxDaysSinceUpload(e.target.value)}
                data-testid="input-scout-max-days"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="scout-min-avg-views" className="flex items-center gap-1.5">
                <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                Min avg views (last 10)
              </Label>
              <Input
                id="scout-min-avg-views"
                type="number"
                inputMode="numeric"
                min={0}
                max={1000000000}
                step={1}
                value={minAvgViews}
                onChange={(e) => setMinAvgViews(e.target.value)}
                data-testid="input-scout-min-avg-views"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="scout-min-engagement" className="flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                Min engagement rate % <span className="text-xs font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="scout-min-engagement"
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                step={0.1}
                placeholder="Leave blank to skip"
                value={minEngagementRate}
                onChange={(e) => setMinEngagementRate(e.target.value)}
                data-testid="input-scout-min-engagement"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="scout-target" className="flex items-center gap-1.5">
                <Target className="h-3.5 w-3.5 text-muted-foreground" />
                Creators to find
              </Label>
              <Input
                id="scout-target"
                type="number"
                inputMode="numeric"
                min={1}
                max={500}
                step={1}
                value={targetCount}
                onChange={(e) => setTargetCount(e.target.value)}
                data-testid="input-scout-target"
              />
              <p className="text-xs text-muted-foreground">Target 1–500. Core flow is 10–50.</p>
            </div>
          </div>

          {validationError && (
            <Alert variant="destructive" data-testid="alert-scout-validation">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Fix the form</AlertTitle>
              <AlertDescription>{validationError}</AlertDescription>
            </Alert>
          )}

          <div className="flex items-center gap-3">
            <Button
              onClick={handleRun}
              disabled={isRunning}
              className="min-w-[148px]"
              data-testid="button-run-scout"
            >
              {isRunning ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Running…
                </>
              ) : (
                <>
                  <Search className="mr-2 h-4 w-4" />
                  Run Scout
                </>
              )}
            </Button>
            {isRunning && (
              <span className="text-sm text-muted-foreground" role="status" aria-live="polite">
                Searching YouTube — this may take a moment. Results appear when the run finishes.
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Provider / validation error from server */}
      {error && (
        <Alert variant="destructive" data-testid="alert-scout-error">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>
            {error.category === "missing_key"
              ? "YouTube API key required"
              : error.category === "invalid_key"
                ? "YouTube API key was rejected"
                : error.category === "quota"
                  ? "YouTube quota is unavailable"
                  : "Scout run failed"}
          </AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{error.suggestion || error.message}</p>
            {(error.category === "missing_key" || error.category === "invalid_key") && (
              <p className="text-xs">
                Configure a key in Settings — the run will rotate across all configured keys automatically.
              </p>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Run status — normal outcome line, not an error. quota_exhausted is partial, not failure. */}
      {hasResults && result && (
        <Card
          className={
            result.stopReason === "quota_exhausted"
              ? "border-amber-500/30 bg-amber-500/[0.04]"
              : result.stopReason === "target_reached"
                ? "border-green-500/20 bg-green-500/[0.04]"
                : "border-border"
          }
          data-testid="scout-run-status"
        >
          <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4 sm:p-5">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                {result.stopReason === "target_reached" && <CheckCircle2 className="h-4 w-4 text-green-600" />}
                {result.stopReason === "quota_exhausted" && <Database className="h-4 w-4 text-amber-600" />}
                {result.stopReason === "keywords_exhausted" && <Info className="h-4 w-4 text-muted-foreground" />}
                <Badge
                  variant={stopReasonLabel(result.stopReason).variant}
                  className={
                    result.stopReason === "quota_exhausted"
                      ? "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                      : result.stopReason === "target_reached"
                        ? "border-green-500/30 bg-green-500/15 text-green-700 dark:text-green-300"
                        : ""
                  }
                  data-testid="badge-stop-reason"
                >
                  {stopReasonLabel(result.stopReason).text}
                </Badge>
                <span className="text-sm font-medium" data-testid="text-found-count">
                  {result.found} / {result.requested} found
                </span>
                <span className="text-sm text-muted-foreground">
                  · {result.keywordsSearched} keyword{result.keywordsSearched === 1 ? "" : "s"} searched
                </span>
              </div>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground" data-testid="text-stop-description">
                {stopReasonDescription(result.stopReason, result.found, result.requested, result.keywordsSearched)}
              </p>
              {result.stopReason === "quota_exhausted" && result.found > 0 && (
                <p className="text-xs text-muted-foreground">
                  Partial results below are valid — channels already evaluated will be skipped on the next run. Add quota
                  or wait for the Pacific midnight reset, then run again.
                </p>
              )}
              {result.stopReason === "quota_exhausted" && result.found === 0 && (
                <p className="text-xs text-muted-foreground">
                  No qualifying channels were found before quota ran out. Try different keywords or reduce filters.
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="hidden sm:inline">Run is synchronous</span>
              <Badge variant="outline" className="font-mono text-xs">
                {result.keywordsSearched} searched
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Results table */}
      {hasResults && (
        <Card data-testid="scout-results-card">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Users className="h-4 w-4 text-primary" />
                  Results
                  <Badge variant="secondary" data-testid="badge-result-count">
                    {channels.length} channel{channels.length === 1 ? "" : "s"}
                  </Badge>
                </CardTitle>
                <CardDescription className="mt-1">
                  Qualified channels only. Channel name links to the channel page. Channels with hidden subscriber
                  counts are never included.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {channels.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                  <Search className="h-5 w-5 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium">No qualifying channels</p>
                <p className="max-w-md text-sm text-muted-foreground">
                  No channels matched all filters for these keywords. Try broadening the subscriber range, lowering the
                  minimum views, or using different keywords. Channels already seen in prior runs are automatically skipped.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[180px]">Channel</TableHead>
                      <TableHead className="whitespace-nowrap">Subscribers</TableHead>
                      <TableHead className="whitespace-nowrap">Avg views</TableHead>
                      <TableHead className="whitespace-nowrap">Engagement</TableHead>
                      <TableHead className="whitespace-nowrap">Last upload</TableHead>
                      <TableHead className="whitespace-nowrap">Days since</TableHead>
                      <TableHead className="min-w-[120px]">Matched keyword</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {channels.map((ch) => (
                      <TableRow key={ch.channel_id} data-testid={`row-channel-${ch.channel_id}`}>
                        <TableCell className="max-w-[260px]">
                          <a
                            href={ch.channel_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
                            data-testid={`link-channel-${ch.channel_id}`}
                          >
                            <span className="truncate">{ch.channel_name}</span>
                            <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-60" />
                          </a>
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">{formatNumber(ch.subscriber_count)}</TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">{formatNumber(ch.avg_views)}</TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">{formatEngagement(ch.engagement_rate_pct)}</TableCell>
                        <TableCell className="whitespace-nowrap">{formatDate(ch.last_upload_date)}</TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">
                          {ch.days_since_last_upload === null || ch.days_since_last_upload === undefined
                            ? "—"
                            : `${ch.days_since_last_upload}d`}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="max-w-[160px] truncate font-normal">
                            {ch.matched_keyword}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Empty state before first run */}
      {!hasResults && !error && !isRunning && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Target className="h-6 w-6 text-primary" />
            </div>
            <p className="text-sm font-medium">No run yet</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Fill in the filters and run the scout. Results and a status line (target reached / all keywords searched /
              quota exhausted) appear here when the run finishes.
            </p>
            <div className="mt-2 flex flex-wrap justify-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3 w-3" /> Max days filters recency
              </span>
              <span className="inline-flex items-center gap-1">
                <Eye className="h-3 w-3" /> Avg over last 10 videos
              </span>
              <span className="inline-flex items-center gap-1">
                <Activity className="h-3 w-3" /> Engagement = (likes+comments)/views
              </span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
