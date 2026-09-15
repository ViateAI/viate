export type PackageArgKind = "source" | "name";

const NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

export function assertSafePackageArg(value: string, kind: PackageArgKind): string {
  if (typeof value !== "string") {
    throw new Error(`${kind} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${kind} is required`);
  }
  if (trimmed.startsWith("-")) {
    throw new Error(`${kind} must not start with "-"`);
  }
  if (trimmed.includes("\0") || /[\r\n]/.test(trimmed)) {
    throw new Error(`invalid ${kind}`);
  }
  if (kind === "name" && !NAME_PATTERN.test(trimmed)) {
    throw new Error("invalid plugin name");
  }
  return trimmed;
}

export function redactSource(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return trimmed;
  }

  const gitPrefix = trimmed.startsWith("git+") ? "git+" : "";
  const rest = gitPrefix ? trimmed.slice(4) : trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rest)) {
    return trimmed.replace(/\/\/[^/?#]*@/g, "//");
  }

  try {
    const url = new URL(rest);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${gitPrefix}${url.toString()}`;
  } catch {
    return trimmed.replace(/\/\/[^/?#]*@/g, "//").replace(/[?#].*$/, "");
  }
}

export function redactInstallerOutput(text: string): string {
  return text
    .replace(/\/\/[^/?#\s]*@/g, "//")
    .replace(/([?&](?:token|access_token|key|password|secret|auth)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{8,}\b/g, "[redacted]")
    .replace(/\b(?:sk-|npm_|github_pat_)[A-Za-z0-9._-]{8,}\b/g, "[redacted]");
}
