import { TARGET_TYPES, type ServiceTargetType } from "./service-creation";

type Metadata = Record<string, unknown>;
export type ProviderCompatibility = { platform: string; targetType: ServiceTargetType };
export type ProviderCompatibilityState = "READY" | "MISSING_METADATA" | "UNSUPPORTED_TARGET";
export type CompatibilityState = "READY" | "MISSING_METADATA" | "UNSUPPORTED_TARGET" | "UNSUPPORTED_PLATFORM" | "PLATFORM_MISMATCH" | "PROVIDER_UNAVAILABLE" | "ALREADY_REPRESENTED";
export type PlatformCompatibilityState = "READY" | "MISSING_METADATA" | "PLATFORM_MISMATCH";

const KNOWN_PLATFORMS = [
  { platform: "instagram", keywords: ["instagram", "ig "] },
  { platform: "tiktok", keywords: ["tiktok", "tik tok"] },
  { platform: "youtube", keywords: ["youtube", "yt "] },
  { platform: "facebook", keywords: ["facebook", "fb "] },
  { platform: "x", keywords: ["twitter", "tweet", " x ", " x/"] },
  { platform: "telegram", keywords: ["telegram", "tg "] },
  { platform: "linkedin", keywords: ["linkedin"] },
  { platform: "spotify", keywords: ["spotify"] },
  { platform: "kick", keywords: ["kick"] },
  { platform: "discord", keywords: ["discord"] },
  { platform: "twitch", keywords: ["twitch"] },
  { platform: "pinterest", keywords: ["pinterest"] },
  { platform: "snapchat", keywords: ["snapchat", "snap"] },
  { platform: "reddit", keywords: ["reddit"] },
  { platform: "soundcloud", keywords: ["soundcloud"] },
  { platform: "threads", keywords: ["threads"] },
];

function declaredText(metadata: Metadata, keys: string[]) {
  const values = keys
    .map((key) => metadata[key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());
  if (values.length === 0) return { value: null, contradictory: false };
  return { value: values[0], contradictory: values.some((value) => value !== values[0]) };
}

function inferProviderTargetType(platform: string, name: string, category: string): string | null {
  const operation = `${name} ${category}`.toLowerCase();
  if (
    platform === "instagram" &&
    /\b(?:likes?|views?|comments?|saves?|reels?)\b/.test(operation)
  ) {
    return "post_url";
  }
  if (platform === "tiktok") {
    if (/\b(?:followers?|fans?|follow)\b/.test(operation)) return "username";
    if (/\b(?:views?|likes?|shares?|saves?|comments?|video)\b/.test(operation)) return "url";
    return "url";
  }
  if (platform === "youtube") {
    if (/\b(?:subscribers?|subs?|channel)\b/.test(operation)) return "channel";
    if (/\b(?:views?|likes?|comments?|shares?|watch|video|shorts?)\b/.test(operation)) return "video_url";
    return "video_url";
  }
  if (platform === "facebook") {
    if (/\bvideo\b/.test(operation) && /\b(?:views?|likes?|comments?)\b/.test(operation)) return "video_url";
    if (/\bpost\b/.test(operation) && /\b(?:likes?|comments?|shares?|reactions?)\b/.test(operation)) return "post_url";
    if (
      /\b(?:page|profile)\b/.test(operation) &&
      /\b(?:followers?|likes?)\b/.test(operation)
    ) {
      return "page";
    }
  }
  // ── Extended platforms ───────────────────────────────────────────────────
  // For platforms where the provider metadata doesn't explicitly declare a
  // target_type, infer from common service name keywords.
  if (platform === "x" || platform === "twitter") {
    if (/\b(?:followers?|follow)\b/.test(operation)) return "username";
    if (/\b(?:likes?|retweets?|replies?|views?|impressions?|comments?)\b/.test(operation)) return "url";
    return "username"; // default to profile
  }
  if (platform === "linkedin") {
    if (/\b(?:followers?|connections?|follow)\b/.test(operation)) return "username";
    if (/\b(?:likes?|comments?|views?|reactions?|shares?)\b/.test(operation)) return "url";
    return "username";
  }
  if (platform === "telegram") {
    if (/\b(?:members?|subscribers?|followers?|views?)\b/.test(operation)) return "username";
    if (/\b(?:post|message)\b/.test(operation) && /\b(?:views?|reactions?|likes?)\b/.test(operation)) return "url";
    return "username";
  }
  if (platform === "pinterest") {
    if (/\b(?:followers?|follow)\b/.test(operation)) return "username";
    if (/\b(?:saves?|repins?|likes?|views?|comments?)\b/.test(operation)) return "url";
    return "username";
  }
  if (platform === "spotify") {
    if (/\b(?:followers?|monthly\s+listeners?|listeners?)\b/.test(operation)) return "username";
    if (/\b(?:plays?|streams?|saves?)\b/.test(operation)) return "url";
    return "username";
  }
  if (platform === "twitch") {
    if (/\b(?:followers?|viewers?|views?)\b/.test(operation)) return "username";
    return "username";
  }
  if (platform === "reddit") {
    if (/\b(?:karma|followers?)\b/.test(operation)) return "username";
    if (/\b(?:upvotes?|downvotes?|comments?|views?)\b/.test(operation)) return "url";
    return "username";
  }
  if (platform === "snapchat") {
    return "username";
  }
  if (platform === "threads") {
    if (/\b(?:followers?|follow)\b/.test(operation)) return "username";
    if (/\b(?:likes?|views?|comments?|reposts?|shares?)\b/.test(operation)) return "url";
    return "username";
  }
  // Any other platform: default to username (profile-based service)
  if (platform) return "username";
  return null;
}

export function detectPlatformFromText(nameAndCategory: string): string | null {
  const haystack = ` ${nameAndCategory.toLowerCase()} `;
  for (const p of KNOWN_PLATFORMS) {
    if (p.keywords.some((k) => haystack.includes(k))) {
      return p.platform;
    }
  }
  return null;
}

export function resolveProviderCompatibility(rawMetadata: unknown, name?: string): { state: ProviderCompatibilityState; compatibility?: ProviderCompatibility; reason: string } {
  const metadata = rawMetadata && typeof rawMetadata === "object" ? rawMetadata as Metadata : {};
  const platform = declaredText(metadata, ["platform", "platform_name", "platformSlug", "platform_slug", "network"]);
  const target = declaredText(metadata, ["target_type", "targetType", "input_type", "inputType"]);
  const category = typeof metadata.category === "string" ? metadata.category : "";
  const resolvedPlatform = platform.value ?? detectPlatformFromText(`${name ?? ""} ${category}`);
  const resolvedTarget = target.value ?? (
    resolvedPlatform ? inferProviderTargetType(resolvedPlatform, name ?? "", category) : null
  );

  if (platform.contradictory || target.contradictory) {
    return { state: "MISSING_METADATA", reason: "Provider platform or target metadata is contradictory." };
  }
  if (!name?.trim()) {
    return { state: "MISSING_METADATA", reason: "Provider service name metadata is required." };
  }
  if (!resolvedPlatform) {
    return { state: "MISSING_METADATA", reason: "Provider platform could not be determined from catalog metadata." };
  }
  if (!resolvedTarget) {
    return { state: "MISSING_METADATA", reason: "Provider target type could not be determined from its service operation." };
  }
  if (!(TARGET_TYPES as readonly string[]).includes(resolvedTarget)) {
    return { state: "UNSUPPORTED_TARGET", reason: "Provider target/input requirement is not supported by VANTA." };
  }
  return {
    state: "READY",
    compatibility: { platform: resolvedPlatform, targetType: resolvedTarget as ServiceTargetType },
    reason: target.value
      ? platform.value
        ? "Provider platform and target are explicitly declared."
        : "Provider platform was inferred from its catalog service name and category."
      : "Provider target type was inferred from its Instagram content service operation.",
  };
}

export function sameProviderPlatform(providerPlatform: string, vantaPlatform: { name?: string; slug?: string | null }) {
  const normalized = providerPlatform.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const nameNorm = vantaPlatform.name ? vantaPlatform.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "";
  const slugNorm = String(vantaPlatform.slug ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-");

  // Handle aliases like twitter -> x
  const aliases: Record<string, string[]> = {
    x: ["twitter", "x", "x-twitter"],
    twitter: ["twitter", "x", "x-twitter"],
    "x-twitter": ["twitter", "x", "x-twitter"],
  };

  if (normalized === nameNorm || normalized === slugNorm) return true;
  if (aliases[normalized]?.includes(slugNorm) || aliases[slugNorm]?.includes(normalized)) return true;
  if (nameNorm && (aliases[normalized]?.includes(nameNorm) || aliases[nameNorm]?.includes(normalized))) return true;

  return false;
}

export function resolveProviderPlatformCompatibility(rawMetadata: unknown, vantaPlatform: { name?: string; slug?: string | null } | null, name?: string): { state: PlatformCompatibilityState; reason: string } {
  const metadata = rawMetadata && typeof rawMetadata === "object" ? rawMetadata as Metadata : {};
  const declared = declaredText(metadata, ["platform", "platform_name", "platformSlug", "platform_slug", "network"]);
  if (declared.contradictory) return { state: "MISSING_METADATA", reason: "Provider platform metadata is contradictory." };
  const category = typeof metadata.category === "string" ? metadata.category : "";
  const providerPlatform = declared.value ?? detectPlatformFromText(`${name ?? ""} ${category}`);
  if (!name?.trim() || !providerPlatform || !vantaPlatform) {
    return { state: "MISSING_METADATA", reason: "Provider service name or VANTA platform metadata is unavailable." };
  }
  if (!sameProviderPlatform(providerPlatform, vantaPlatform)) return { state: "PLATFORM_MISMATCH", reason: "Provider platform does not match the VANTA platform." };
  return {
    state: "READY",
    reason: declared.value
      ? "Provider platform matches the VANTA platform."
      : "Provider platform was inferred from its catalog service name and category.",
  };
}

export function matchesApprovedProviderOperation(serviceSlug: string, providerServiceId: string, name: string, category: string) {
  const approvedOperations: Record<string, Array<{ providerServiceId: string; servicePhrase: string; categoryPhrase: string }>> = {
    "instagram-likes": [
      { providerServiceId: "5911", servicePhrase: "instagram likes", categoryPhrase: "instagram likes" },
      { providerServiceId: "1881", servicePhrase: "instagram likes", categoryPhrase: "instagram new services" },
    ],
    "instagram-views": [{ providerServiceId: "7486", servicePhrase: "instagram video views", categoryPhrase: "instagram services" }],
    "instagram-saves": [{ providerServiceId: "7841", servicePhrase: "instagram saves", categoryPhrase: "instagram services" }],
    "tiktok-followers": [{ providerServiceId: "7054", servicePhrase: "tiktok followers", categoryPhrase: "tiktok followers" }],
    "tiktok-views": [{ providerServiceId: "5661", servicePhrase: "tiktok video views", categoryPhrase: "tiktok video views" }],
    "tiktok-shares": [{ providerServiceId: "7580", servicePhrase: "tiktok video shares", categoryPhrase: "tiktok video services" }],
    "youtube-subscribers": [{ providerServiceId: "7458", servicePhrase: "youtube subscribers", categoryPhrase: "youtube subscribers" }],
    "youtube-likes": [{ providerServiceId: "4210", servicePhrase: "youtube likes", categoryPhrase: "youtube likes" }],
    "facebook-page-followers": [{ providerServiceId: "7229", servicePhrase: "facebook followers", categoryPhrase: "facebook followers" }],
    "facebook-post-likes": [
      { providerServiceId: "7099", servicePhrase: "facebook post likes", categoryPhrase: "facebook post likes" },
      { providerServiceId: "2813", servicePhrase: "facebook post reactions", categoryPhrase: "facebook post reaction" },
      { providerServiceId: "8008", servicePhrase: "facebook post reactions", categoryPhrase: "facebook post reaction" },
      { providerServiceId: "8009", servicePhrase: "facebook post reactions", categoryPhrase: "facebook post reaction" },
      { providerServiceId: "8010", servicePhrase: "facebook post reactions", categoryPhrase: "facebook post reaction" },
      { providerServiceId: "8002", servicePhrase: "facebook post reactions", categoryPhrase: "facebook post reaction" },
      { providerServiceId: "2127", servicePhrase: "facebook post reaction", categoryPhrase: "facebook post reactions" },
      { providerServiceId: "5611", servicePhrase: "facebook post reaction", categoryPhrase: "facebook post reactions" },
    ],
    "facebook-video-views": [{ providerServiceId: "7603", servicePhrase: "facebook views", categoryPhrase: "facebook views" }],
    "instagram-comments": [
      { providerServiceId: "7855", servicePhrase: "instagram comments", categoryPhrase: "instagram services" },
      { providerServiceId: "7856", servicePhrase: "instagram comments", categoryPhrase: "instagram services" },
      { providerServiceId: "7843", servicePhrase: "instagram random comments", categoryPhrase: "instagram services" },
      { providerServiceId: "7916", servicePhrase: "instagram custom comments", categoryPhrase: "instagram comments" },
      { providerServiceId: "7917", servicePhrase: "instagram random comments", categoryPhrase: "instagram comments" },
      { providerServiceId: "7918", servicePhrase: "instagram emoji comments", categoryPhrase: "instagram comments" },
      { providerServiceId: "2113", servicePhrase: "instagram positive emoji comments", categoryPhrase: "instagram comments" },
    ],
    "tiktok-comments": [
      { providerServiceId: "7974", servicePhrase: "tiktok custom comments", categoryPhrase: "tiktok comments" },
      { providerServiceId: "7975", servicePhrase: "tiktok custom comments", categoryPhrase: "tiktok comments" },
      { providerServiceId: "7976", servicePhrase: "tiktok random comments", categoryPhrase: "tiktok comments" },
      { providerServiceId: "7980", servicePhrase: "tiktok custom comments", categoryPhrase: "tiktok comments" },
      { providerServiceId: "7981", servicePhrase: "tiktok random", categoryPhrase: "tiktok comments" },
      { providerServiceId: "7982", servicePhrase: "tiktok comments", categoryPhrase: "tiktok comments" },
    ],
    "youtube-comments": [
      { providerServiceId: "7969", servicePhrase: "youtube custom comments", categoryPhrase: "youtube comments" },
      { providerServiceId: "7970", servicePhrase: "youtube custom comments", categoryPhrase: "youtube comments" },
    ],
  };
  const operation = Object.entries(approvedOperations).find(([slug]) =>
    serviceSlug === slug || serviceSlug.startsWith(`${slug}-`)
  )?.[1];
  const expected = operation?.find((candidate) => candidate.providerServiceId === providerServiceId);
  if (!expected) return false;
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return normalize(name).includes(expected.servicePhrase) && normalize(category).startsWith(expected.categoryPhrase);
}
