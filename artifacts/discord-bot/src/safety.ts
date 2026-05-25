import Filter from "bad-words";

const filter = new Filter();

const SPAM_PATTERNS = [
  /(.)\1{6,}/,
  /https?:\/\/[^\s]+/gi,
  /discord\.gg\/[a-z0-9]+/gi,
  /free\s*(nitro|robux|vbucks|gift)/gi,
  /click\s*here\s*(to|and)\s*(get|claim)/gi,
  /\$\d+\s*(per|a)\s*(day|week|hour)/gi,
];

const SLUR_PATTERNS = [
  /\bn[i1!]+[g9]+[ge3]+r/gi,
  /\bf[a@4]+[g9]+[o0]+[t7]+/gi,
  /\bk[i1!]+[k9]+[e3]+/gi,
  /\bs[p]+[i1!]+[c]+/gi,
  /\bch[i1!]+nk/gi,
  /\bw[e3]+[t7]+b[a@4]+[c]+[k9]+/gi,
  /\bc[o0]+[o0]+n\b/gi,
  /\bt[r]+[a@4]+[n]+[n]+[y]/gi,
];

const NSFW_PATTERNS = [
  /\b(porn|nude|naked|sex|xxx|onlyfans|hentai|nsfw)\b/gi,
  /\b(dick|cock|pussy|ass|boobs|tits|cum|fuck|shit|bitch|whore|slut)\b/gi,
];

const SCAM_PATTERNS = [
  /free\s*nitro/gi,
  /steam\s*gift/gi,
  /claim\s*your\s*(prize|reward|gift)/gi,
  /you\s*(have\s*)?(won|win)/gi,
  /(urgent|immediately|act\s*now).*\s*(click|visit|go\s*to)/gi,
  /airdrop/gi,
  /crypto\s*(giveaway|investment)/gi,
];

const PRIVILEGED_ROLE_NAMES = ["owner", "co owner", "co-owner", "admin"];

export interface SafetyResult {
  safe: boolean;
  reason?: string;
}

function hasSlur(content: string): boolean {
  for (const pattern of SLUR_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) return true;
  }
  return false;
}

function hasNsfw(content: string): boolean {
  for (const pattern of NSFW_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) return true;
  }
  return false;
}

function hasScam(content: string): boolean {
  for (const pattern of SCAM_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) return true;
  }
  return false;
}

function hasSpam(content: string): boolean {
  for (const pattern of SPAM_PATTERNS) {
    if (typeof (pattern as RegExp).lastIndex !== "undefined") {
      (pattern as RegExp).lastIndex = 0;
    }
    if (pattern.test(content)) return true;
  }
  return false;
}

export function isPrivilegedRole(roleNames: string[]): boolean {
  return roleNames.some((r) =>
    PRIVILEGED_ROLE_NAMES.some((p) => r.toLowerCase().includes(p))
  );
}

// Full check — used for moderation logging and general safety gates
export function checkSafety(content: string): SafetyResult {
  if (!content || content.trim().length === 0) {
    return { safe: false, reason: "empty" };
  }
  if (content.length > 2000) {
    return { safe: false, reason: "too_long" };
  }
  if (hasSlur(content)) return { safe: false, reason: "slur" };
  if (hasNsfw(content)) return { safe: false, reason: "nsfw" };
  if (hasScam(content)) return { safe: false, reason: "scam" };
  if (hasSpam(content)) return { safe: false, reason: "spam" };

  const mentionMatches = content.match(/<@[!&]?\d+>/g) ?? [];
  if (mentionMatches.length > 5) {
    return { safe: false, reason: "mass_mention" };
  }

  try {
    if (filter.isProfane(content)) {
      return { safe: false, reason: "profanity" };
    }
  } catch {
  }

  return { safe: true };
}

/**
 * Looser check used only on AI reply output.
 * Allows swearing and general insults — only blocks slurs, scams, and mass mentions.
 * This lets the bot clap back properly without getting silently killed.
 */
export function checkAIOutput(content: string): SafetyResult {
  if (!content || content.trim().length === 0) {
    return { safe: false, reason: "empty" };
  }
  if (content.length > 2000) {
    return { safe: false, reason: "too_long" };
  }
  if (hasSlur(content)) return { safe: false, reason: "slur" };
  if (hasScam(content)) return { safe: false, reason: "scam" };

  const mentionMatches = content.match(/<@[!&]?\d+>/g) ?? [];
  if (mentionMatches.length > 5) {
    return { safe: false, reason: "mass_mention" };
  }

  return { safe: true };
}

export function checkLearning(
  content: string,
  privileged: boolean
): SafetyResult {
  if (!content || content.trim().length === 0) {
    return { safe: false, reason: "empty" };
  }
  if (content.length > 2000) {
    return { safe: false, reason: "too_long" };
  }

  if (hasScam(content)) return { safe: false, reason: "scam" };
  if (hasSpam(content)) return { safe: false, reason: "spam" };

  const mentionMatches = content.match(/<@[!&]?\d+>/g) ?? [];
  if (mentionMatches.length > 5) {
    return { safe: false, reason: "mass_mention" };
  }

  if (!privileged) {
    if (hasSlur(content)) return { safe: false, reason: "slur" };
    if (hasNsfw(content)) return { safe: false, reason: "nsfw" };

    try {
      if (filter.isProfane(content)) {
        return { safe: false, reason: "profanity" };
      }
    } catch {
    }
  }

  return { safe: true };
}

export function sanitizeForLearning(content: string): string {
  return content
    .replace(/<@[!&]?\d+>/g, "@user")
    .replace(/<#\d+>/g, "#channel")
    .replace(/<:[a-z0-9_]+:\d+>/gi, "")
    .replace(/https?:\/\/[^\s]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function isSpam(content: string, recentMessages: string[]): boolean {
  const identical = recentMessages.filter((m) => m === content);
  if (identical.length >= 3) return true;

  const similar = recentMessages.filter((m) => {
    if (m.length === 0 || content.length === 0) return false;
    const shorter = Math.min(m.length, content.length);
    const longer = Math.max(m.length, content.length);
    if (longer === 0) return false;
    let matches = 0;
    for (let i = 0; i < shorter; i++) {
      if (m[i] === content[i]) matches++;
    }
    return matches / longer > 0.9;
  });

  return similar.length >= 2;
}
