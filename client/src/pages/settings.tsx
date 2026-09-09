import { FormEvent, useEffect, useState } from "react";
import { ExternalLink, Eye, EyeOff, KeyRound, Loader2, Save, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface ApiKeyStatus {
  youtube: boolean;
  youtubeKeyCount: number;
}

const COMMUNITIES = [
  {
    id: "free",
    title: "AI Marketing Hub",
    tier: "Free community",
    url: "https://www.skool.com/ai-marketing-hub",
    colors: ["#F1B43C", "#3D8FD1", "#D64A43"],
  },
  {
    id: "pro",
    title: "AI Marketing Hub Pro",
    tier: "Pro community",
    url: "https://www.skool.com/ai-marketing-hub-pro",
    colors: ["#D64A43", "#E2A33A", "#4D9B65"],
  },
] as const;

function CommunityMark({
  colors,
}: {
  colors: readonly [string, string, string];
}) {
  const heights = ["h-3", "h-5", "h-4"] as const;

  return (
    <span
      aria-hidden="true"
      className="flex h-10 w-10 shrink-0 items-end justify-center gap-1 rounded-lg border border-border bg-background px-2 pb-2"
    >
      {colors.map((color, index) => (
        <span
          className={`w-1 rounded-full ${heights[index]}`}
          key={color}
          style={{ backgroundColor: color }}
        />
      ))}
    </span>
  );
}

function parseKeysForCount(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function SettingsPage() {
  const [status, setStatus] = useState<ApiKeyStatus>({
    youtube: false,
    youtubeKeyCount: 0,
  });
  const [keysText, setKeysText] = useState("");
  const [showKeys, setShowKeys] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { toast } = useToast();

  const parsedCount = parseKeysForCount(keysText).length;

  useEffect(() => {
    const loadStatus = async () => {
      try {
        const response = await fetch("/api/settings/status", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to load settings.");
        setStatus({
          youtube: Boolean(data.youtube),
          youtubeKeyCount: typeof data.youtubeKeyCount === "number" ? data.youtubeKeyCount : 0,
        });
      } catch (error: unknown) {
        setLoadError(error instanceof Error ? error.message : "Unable to load settings.");
      } finally {
        setIsLoading(false);
      }
    };

    loadStatus();
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const raw = keysText.trim();
    if (!raw) {
      toast({
        title: "No changes to save",
        description: "Paste one or more YouTube API keys (one per line or comma-separated).",
      });
      return;
    }

    setIsSaving(true);
    try {
      const response = (await apiRequest("PUT", "/api/settings/api-keys", {
        youtubeApiKeys: raw,
      })) as { success: boolean; status: ApiKeyStatus };

      setStatus({
        youtube: Boolean(response.status.youtube),
        youtubeKeyCount: typeof response.status.youtubeKeyCount === "number" ? response.status.youtubeKeyCount : 0,
      });
      setKeysText("");
      toast({
        title: "API settings saved",
        description:
          response.status.youtubeKeyCount > 1
            ? `${response.status.youtubeKeyCount} YouTube keys saved. Rotation order is the order you pasted them.`
            : "The local server is using the updated YouTube API key.",
      });
    } catch (error: unknown) {
      toast({
        title: "Could not save settings",
        description: error instanceof Error ? error.message : "Check the keys and try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6 md:p-8">
      <div>
        <div className="flex items-center gap-2 text-primary">
          <KeyRound className="h-5 w-5" />
          <span className="text-sm font-medium">Local connections</span>
        </div>
        <h1 className="mt-2 text-3xl font-bold">Settings</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Connect the YouTube Data API keys used for Creator Scout.
        </p>
      </div>

      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>Stored locally</AlertTitle>
        <AlertDescription>
          Keys are written to the server&apos;s ignored <code>.env</code> file with owner-only
          permissions. Saved values are never returned to the browser and the input is cleared
          after saving. Settings changes are accepted only from this machine.
        </AlertDescription>
      </Alert>

      {loadError && (
        <Alert variant="destructive">
          <AlertTitle>Settings unavailable</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>API connections</CardTitle>
          <CardDescription>
            Paste one YouTube API key per line or comma-separated. Leave blank to keep the current
            value. Order is rotation order.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex min-h-48 items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Loading connection status
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-3 rounded-lg border border-border bg-background/50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <Label htmlFor="youtube-api-keys" className="text-base">
                      YouTube Data API
                    </Label>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Required for Creator Scout. Add multiple keys to enable automatic quota rotation
                      — the server uses them in the order listed.
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      status.youtube
                        ? "border-green-500/40 bg-green-500/10 text-green-500"
                        : "text-muted-foreground"
                    }
                  >
                    {status.youtube
                      ? status.youtubeKeyCount > 0
                        ? `Configured · ${status.youtubeKeyCount} key${status.youtubeKeyCount === 1 ? "" : "s"}`
                        : "Configured"
                      : "Not configured"}
                  </Badge>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="youtube-api-keys" className="text-sm">
                      YouTube API keys
                    </Label>
                    <span className="text-xs text-muted-foreground">
                      {parsedCount > 0 ? `${parsedCount} key${parsedCount === 1 ? "" : "s"} pasted` : "One per line or comma-separated"}
                    </span>
                  </div>
                  <div className="relative">
                    <Textarea
                      id="youtube-api-keys"
                      value={keysText}
                      onChange={(e) => setKeysText(e.target.value)}
                      placeholder={
                        status.youtube
                          ? "Enter replacement keys (one per line) — leave blank to keep current keys"
                          : "Paste YouTube API keys — one per line or comma-separated"
                      }
                      rows={5}
                      spellCheck={false}
                      autoComplete="off"
                      className="min-h-[120px] pr-11 font-mono text-sm"
                      style={!showKeys ? { WebkitTextSecurity: "disc" } as React.CSSProperties : undefined}
                      data-testid="input-youtube-api-keys"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-0 top-0"
                      onClick={() => setShowKeys((visible) => !visible)}
                      aria-label={showKeys ? "Hide YouTube API keys" : "Show YouTube API keys"}
                      data-testid="button-toggle-youtube-keys"
                    >
                      {showKeys ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Stored as <code>YOUTUBE_API_KEYS</code> (comma-separated) in <code>.env</code> with{" "}
                    <code>0o600</code>. Never echoed back to the browser.
                  </p>
                </div>

                <a
                  href="https://console.cloud.google.com/apis/credentials"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  Open Google Cloud credentials
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>

              <div className="flex justify-end pt-2">
                <Button
                  type="submit"
                  disabled={isSaving || Boolean(loadError)}
                  data-testid="button-save-api-settings"
                >
                  {isSaving ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="mr-2 h-4 w-4" />
                  )}
                  Save and apply
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <Card aria-labelledby="community-heading">
        <CardHeader>
          <CardTitle id="community-heading" className="text-lg">
            Join the community
          </CardTitle>
          <CardDescription>Connect with AI marketers, share what you learn, and get support.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {COMMUNITIES.map((community) => (
            <a
              key={community.url}
              href={community.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Join ${community.title}, ${community.tier}`}
              className="group flex min-w-0 items-center gap-3 rounded-lg border border-border bg-background/50 p-3 transition-colors hover:border-primary/40 hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid={`link-community-${community.id}`}
            >
              <CommunityMark colors={community.colors} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{community.title}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{community.tier}</span>
              </span>
              <ExternalLink
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
              />
            </a>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
