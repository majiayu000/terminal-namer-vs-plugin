/**
 * Sanitize shell command history before it is sent to third-party AI providers.
 * Redacts secrets, caps length, and optionally keeps only argv0 (command name).
 */

export interface SanitizeOptions {
  /** Max characters kept per command after sanitization (default 120). */
  maxCommandLength?: number;
  /** When true, send only the executable/command name (argv0). */
  argv0Only?: boolean;
}

const DEFAULT_MAX_LENGTH = 120;

/**
 * Assignment-style secrets: TOKEN=..., KEY=..., PASSWORD=..., including quoted
 * values that may contain whitespace (e.g. export API_KEY="correct horse").
 */
const ENV_ASSIGNMENT =
  /\b(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s'"]+))/g;

const SECRET_ENV_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|BEARER|AUTH|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|(?:^|_)KEY(?:_|$))/i;

/** Authorization / Bearer / Basic headers */
const AUTH_HEADER =
  /(?:Authorization|X-Api-Key|X-Auth-Token)\s*[:=]\s*(?:Bearer\s+|Basic\s+)?['"]?[^\s'"]+/gi;

/** Common password / token / user CLI flags with their values */
const SECRET_FLAG_NAMES =
  '-p|--password|--passwd|--pass|--secret|--token|--api[-_]?key|--access[-_]?key|--auth|-u|--user';

const SECRET_FLAGS = new RegExp(
  `(?:^|\\s)(?:${SECRET_FLAG_NAMES})(?:=|\\s+)(['"]?)[^\\s'"]+\\1`,
  'gi'
);

/** mysql/psql style -pPASSWORD (no space) */
const COMPACT_PASSWORD_FLAG = /(?:^|\s)-p(?!$)([^\s-][^\s]*)/g;

/** High-entropy tokens (API keys, JWTs, long hex/base64 including `/`) */
const HIGH_ENTROPY =
  /(?:^|[^A-Za-z0-9+/=_.-])([A-Za-z0-9+/=_.-]{32,})(?![A-Za-z0-9+/=_.-])/g;

/** URL userinfo credentials, including empty username (`redis://:pass@host`) */
const URL_EMBEDDED_CREDS = /:\/\/[^/\s:@]*:[^/\s@]+@/g;
const USERINFO_CREDS = /\b([A-Za-z0-9._-]*):([^@\s/]+)@/g;

const REDACTED = '[REDACTED]';

/**
 * Skip leading shell VAR=value assignments, including quoted values with spaces.
 */
function skipLeadingAssignments(command: string): string {
  let i = 0;
  const s = command;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) {
      i++;
    }
    const rest = s.slice(i);
    const m = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!m) {
      break;
    }
    i += m[0].length;
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i]!;
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\' && i + 1 < s.length) {
          i += 2;
        } else {
          i++;
        }
      }
      if (i < s.length) {
        i++; // closing quote
      }
    } else {
      while (i < s.length && !/\s/.test(s[i]!)) {
        i++;
      }
    }
  }
  return s.slice(i).trimStart();
}

/**
 * Extract argv0 (command name) from a shell command line.
 * Strips env assignments and path prefixes: `FOO=1 /usr/bin/npm run` → `npm`
 */
export function extractArgv0(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return '';
  }

  const withoutEnv = skipLeadingAssignments(trimmed);
  const first = withoutEnv.split(/\s+/)[0] || '';
  // Drop path: /usr/bin/npm → npm, .\foo.cmd → foo.cmd
  const base = first.replace(/^.*[/\\]/, '');
  return base || first;
}

function redactHighEntropy(command: string): string {
  return command.replace(HIGH_ENTROPY, (match, token: string) => {
    // Skip if mostly the same character (unlikely a secret)
    if (/^(.)\1+$/.test(token)) {
      return match;
    }
    // Require mixed charset or typical API-key prefixes to reduce false positives
    const hasDigit = /\d/.test(token);
    const hasLetter = /[A-Za-z]/.test(token);
    const looksLikeJwt = token.split('.').length >= 3 && token.length >= 40;
    const looksLikeKey =
      /^(sk-|pk-|rk-|AKIA|ghp_|gho_|xox[baprs]-|ya29\.|eyJ)/i.test(token) ||
      (hasDigit && hasLetter && token.length >= 32);

    if (!looksLikeJwt && !looksLikeKey) {
      return match;
    }

    const prefix = match.slice(0, match.length - token.length);
    return `${prefix}${REDACTED}`;
  });
}

/**
 * Sanitize a single shell command line for safe inclusion in an AI prompt.
 */
export function sanitizeCommand(command: string, options: SanitizeOptions = {}): string {
  const maxLen = options.maxCommandLength ?? DEFAULT_MAX_LENGTH;

  if (options.argv0Only) {
    const argv0 = extractArgv0(command);
    return argv0.slice(0, maxLen);
  }

  let result = command.trim();
  if (!result) {
    return '';
  }

  result = result.replace(
    ENV_ASSIGNMENT,
    (full, name: string, singleQuoted?: string, doubleQuoted?: string, bare?: string) => {
      if (!SECRET_ENV_NAME.test(name)) {
        return full;
      }
      const value = singleQuoted ?? doubleQuoted ?? bare ?? '';
      // Reconstruct so only the assignment value is redacted
      const exportPrefix = full.match(/^export\s+/i)?.[0] ?? '';
      const quote =
        singleQuoted !== undefined ? "'" : doubleQuoted !== undefined ? '"' : '';
      return `${exportPrefix}${name}=${quote}${REDACTED}${quote}`;
    }
  );

  result = result.replace(AUTH_HEADER, (m) => {
    const sep = m.search(/[:=]/);
    if (sep === -1) {
      return REDACTED;
    }
    return `${m.slice(0, sep + 1)} ${REDACTED}`;
  });

  result = result.replace(SECRET_FLAGS, (m) => {
    const trimmedFlag = m.trimStart();
    const flagMatch = trimmedFlag.match(
      new RegExp(`^(${SECRET_FLAG_NAMES})`, 'i')
    );
    const flag = flagMatch ? flagMatch[1] : '--secret';
    const leading = m.slice(0, m.length - trimmedFlag.length);
    return `${leading}${flag}=${REDACTED}`;
  });

  result = result.replace(COMPACT_PASSWORD_FLAG, (_m, value: string) => {
    // Avoid rewriting short non-password -p flags like `ps -p 123`
    if (/^\d+$/.test(value)) {
      return ` -p${value}`;
    }
    return ` -p${REDACTED}`;
  });

  result = result.replace(URL_EMBEDDED_CREDS, '://[REDACTED]@');
  result = result.replace(USERINFO_CREDS, '$1:[REDACTED]@');
  result = redactHighEntropy(result);

  if (result.length > maxLen) {
    result = `${result.slice(0, maxLen)}…`;
  }

  return result;
}

/**
 * Sanitize a list of commands (dedupe is left to the caller / prompt builder).
 */
export function sanitizeCommands(commands: string[], options: SanitizeOptions = {}): string[] {
  return commands
    .map((cmd) => sanitizeCommand(cmd, options))
    .filter((cmd) => cmd.length > 0);
}
