import { useCallback, useEffect, useState } from "react";
import {
  History, Plus, Loader2, ExternalLink, CheckCircle2, AlertCircle, Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

// One row of the flat exclusion list, as returned by GET /api/history.
type HistoryRow = {
  channel_id: string;
  channel_url: string;
  channel_name: string | null;
  source: "search" | "manual";
  matched_keyword: string | null;
  added_at: string;
};

type AddFeedback =
  | { kind: "added"; message: string }
  | { kind: "already"; message: string }
  | { kind: "error"; title: string; message: string };

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

export default function HistoryPage() {
  const [channels, setChannels] = useState<HistoryRow[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [feedback, setFeedback] = useState<AddFeedback | null>(null);

  const loadHistory = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/history", { credentials: "include" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(
          typeof payload.error === "string" ? payload.error : res.statusText || "Could not load history.",
        );
        setChannels([]);
        return;
      }
      setChannels(Array.isArray(payload.channels) ? (payload.channels as HistoryRow[]) : []);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : "Could not load history.");
      setChannels([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const handleAdd = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isAdding) return;
    setIsAdding(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/history/manual-add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ input: trimmed }),
      });
      const payload = await res.json().catch(() => ({}));

      if (res.ok) {
        const name =
          typeof payload?.channel?.channel_name === "string" && payload.channel.channel_name
            ? payload.channel.channel_name
            : trimmed;
        setFeedback({ kind: "added", message: `Added “${name}” — future scout runs will skip it.` });
        setInput("");
        await loadHistory();
        return;
      }

      const serverMessage =
        typeof payload.error === "string" && payload.error ? payload.error : res.statusText || "Could not add channel.";
      if (payload.status === "already-in-history") {
        setFeedback({ kind: "already", message: serverMessage });
        return;
      }
      const title =
        payload.status === "invalid-input"
          ? "That doesn't look like a channel"
          : payload.status === "channel-not-found"
            ? "Channel not found"
            : payload.status === "quota-exhausted"
              ? "YouTube quota is unavailable"
              : "Could not add channel";
        const suggestion = typeof payload.suggestion === "string" ? payload.suggestion : undefined;
      setFeedback({
        kind: "error",
        title,
        message: suggestion ? `${serverMessage} ${suggestion}` : serverMessage,
      });
    } catch (e: unknown) {
      const offline = typeof navigator !== "undefined" && !navigator.onLine;
      setFeedback({
        kind: "error",
        title: "Could not add channel",
        message:
          e instanceof Error
            ? e.message
            : offline
              ? "You appear to be offline. Check your connection and retry."
              : "The add request could not be completed.",
      });
    } finally {
      setIsAdding(false);
    }
  }, [input, isAdding, loadHistory]);

  const rows = channels ?? [];
  const addDisabled = isAdding || input.trim().length === 0;

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-6 p-4 lg:p-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 text-primary">
          <History className="h-5 w-5" />
          <span className="text-sm font-medium">History</span>
        </div>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Exclusion list</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Every channel the scout will skip — found via search or added manually. This is the flat exclusion
          list, not a per-run log.
        </p>
      </div>

      {/* Manual add */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Plus className="h-5 w-5 text-primary" />
            Add a channel
          </CardTitle>
          <CardDescription>
            Paste a channel link, an @handle, or a channel ID. The link is resolved through the YouTube API
            (1 quota unit) so a mistyped ID never silently sits in history.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="history-add-input">Channel link, @handle, or channel ID</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="history-add-input"
                placeholder="https://www.youtube.com/@somechannel — or @somechannel, or UC…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleAdd();
                }}
                disabled={isAdding}
                className="font-mono text-sm"
                data-testid="input-history-add"
                aria-describedby="history-add-cost-note"
              />
              <Button
                onClick={() => void handleAdd()}
                disabled={addDisabled}
                className="min-w-[120px] shrink-0"
                data-testid="button-history-add"
              >
                {isAdding ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Adding…
                  </>
                ) : (
                  <>
                    <Plus className="mr-2 h-4 w-4" />
                    Add
                  </>
                )}
              </Button>
            </div>
            <p id="history-add-cost-note" className="text-xs text-muted-foreground">
              Note: legacy /c/CustomName links cost about 100 quota units to resolve (a channel search) —
              every other format costs 1 unit.
            </p>
          </div>

          {isAdding && (
            <span className="text-sm text-muted-foreground" role="status" aria-live="polite">
              Resolving through the YouTube API — this is a real network call, not instant validation.
            </span>
          )}

          {feedback?.kind === "added" && (
            <Alert
              className="border-green-500/30 bg-green-500/[0.04]"
              data-testid="alert-history-feedback"
            >
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertTitle>Added to history</AlertTitle>
              <AlertDescription>{feedback.message}</AlertDescription>
            </Alert>
          )}

          {feedback?.kind === "already" && (
            <Alert
              className="border-amber-500/30 bg-amber-500/[0.04]"
              data-testid="alert-history-feedback"
            >
              <Info className="h-4 w-4 text-amber-600" />
              <AlertTitle>Already in history</AlertTitle>
              <AlertDescription>{feedback.message}</AlertDescription>
            </Alert>
          )}

          {feedback?.kind === "error" && (
            <Alert variant="destructive" data-testid="alert-history-feedback">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{feedback.title}</AlertTitle>
              <AlertDescription>{feedback.message}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* History table */}
      <Card data-testid="history-table-card">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="h-4 w-4 text-primary" />
                Channels
                {!isLoading && (
                  <Badge variant="secondary" data-testid="badge-history-count">
                    {rows.length} channel{rows.length === 1 ? "" : "s"}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="mt-1">
                Newest first. Channel name links to the channel page.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 px-6 py-12 text-sm text-muted-foreground" role="status" aria-live="polite">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading history…
            </div>
          ) : loadError ? (
            <div className="px-6 py-6">
              <Alert variant="destructive" data-testid="alert-history-load-error">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Could not load history</AlertTitle>
                <AlertDescription>{loadError}</AlertDescription>
              </Alert>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                <History className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">No history yet</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Channels found by scout runs and channels you add above will appear here. Anything listed
                here is skipped by future scout runs.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[180px]">Channel</TableHead>
                    <TableHead className="whitespace-nowrap">Source</TableHead>
                    <TableHead className="min-w-[120px]">Matched keyword</TableHead>
                    <TableHead className="whitespace-nowrap">Added</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.channel_id} data-testid={`row-history-${row.channel_id}`}>
                      <TableCell className="max-w-[260px]">
                        <a
                          href={row.channel_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
                          data-testid={`link-history-${row.channel_id}`}
                        >
                          <span className="truncate">{row.channel_name || row.channel_id}</span>
                          <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-60" />
                        </a>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {row.source === "manual" ? (
                          <Badge variant="default">Manually added</Badge>
                        ) : (
                          <Badge variant="secondary">Found via search</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {row.matched_keyword ? (
                          <Badge variant="outline" className="max-w-[160px] truncate font-normal">
                            {row.matched_keyword}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(row.added_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
