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

const SECRET_ENV_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|BEARER|AUTH|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|MYSQL_PWD|PGPASSWORD|_PWD$|(?:^|_)KEY(?:_|$))/i;

/** True when `i` can start a shell assignment (start of string or non-identifier). */
function canStartAssignment(s: string, i: number): boolean {
  if (i === 0) {
    return true;
  }
  return !/[A-Za-z0-9_]/.test(s[i - 1]!);
}

/** Authorization / Bearer / Basic / X-Api-Key style header names */
const AUTH_HEADER_NAME = /(?:Authorization|X-Api-Key|X-Auth-Token)/gi;

/** Common password / token / user CLI flags with their values */
const SECRET_FLAG_NAMES =
  '-p|--password|--passwd|--pass|--secret|--token|--api[-_]?key|--access[-_]?key|--auth|-u|--user';

const SECRET_FLAG_PREFIX = new RegExp(`^(${SECRET_FLAG_NAMES})`, 'i');

/** mysql/psql style -pPASSWORD (no space). Glued form is password-bearing; `ps -p 123` uses a space. */
const COMPACT_PASSWORD_FLAG = /(?:^|\s)-p(?!$)([^\s-][^\s]*)/g;

/** High-entropy tokens (API keys, JWTs, long hex/base64 including `/`) */
const HIGH_ENTROPY =
  /(?:^|[^A-Za-z0-9+/=_.-])([A-Za-z0-9+/=_.-]{32,})(?![A-Za-z0-9+/=_.-])/g;

/** URL userinfo credentials, including empty username (`redis://:pass@host`) */
const URL_EMBEDDED_CREDS = /:\/\/[^/\s:@]*:[^/\s@]+@/g;
const USERINFO_CREDS = /\b([A-Za-z0-9._-]*):([^@\s/]+)@/g;

const REDACTED = '[REDACTED]';

/**
 * Advance past a balanced `$(...)` starting at `i` (s[i] === '$' and s[i+1] === '(').
 */
function skipDollarParen(s: string, i: number): number {
  // s[i] === '$', s[i+1] === '('
  i += 2;
  let depth = 1;
  while (i < s.length && depth > 0) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\' && q === '"' && i + 1 < s.length) {
          i += 2;
        } else {
          i++;
        }
      }
      if (i < s.length) {
        i++;
      }
      continue;
    }
    if (c === '`') {
      i = skipBacktick(s, i);
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      depth++;
      i += 2;
      continue;
    }
    if (c === '(') {
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth--;
      i++;
      continue;
    }
    i++;
  }
  return i;
}

/**
 * Advance past a backtick-quoted substitution starting at `i` (s[i] === '`').
 */
function skipBacktick(s: string, i: number): number {
  i++; // opening `
  while (i < s.length && s[i] !== '`') {
    if (s[i] === '\\' && i + 1 < s.length) {
      i += 2;
    } else {
      i++;
    }
  }
  if (i < s.length) {
    i++; // closing `
  }
  return i;
}

/**
 * Advance past a balanced `${...}` brace expansion starting at `i`
 * (s[i] === '$' and s[i+1] === '{'). Handles nested braces and quotes so
 * forms like `${FALLBACK:-correct horse battery}` stay one shell word.
 */
function skipDollarBrace(s: string, i: number): number {
  // s[i] === '$', s[i+1] === '{'
  i += 2;
  let depth = 1;
  while (i < s.length && depth > 0) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\' && q === '"' && i + 1 < s.length) {
          i += 2;
        } else {
          i++;
        }
      }
      if (i < s.length) {
        i++;
      }
      continue;
    }
    if (c === '`') {
      i = skipBacktick(s, i);
      continue;
    }
    if (c === '$' && s[i + 1] === '{') {
      depth++;
      i += 2;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      i = skipDollarParen(s, i);
      continue;
    }
    if (c === '{') {
      depth++;
      i++;
      continue;
    }
    if (c === '}') {
      depth--;
      i++;
      continue;
    }
    i++;
  }
  return i;
}

/**
 * Advance past one shell word: quoted segments (with internal whitespace),
 * concatenations such as `correct" horse battery"`, escapes (`a\ b`), and
 * `$()` / `${...}` / `` ` `` substitutions. Unquoted whitespace ends the word.
 */
function skipShellWord(s: string, i: number): number {
  if (i >= s.length || /\s/.test(s[i]!)) {
    return i;
  }

  while (i < s.length) {
    const c = s[i]!;

    // Unquoted whitespace terminates the word
    if (/\s/.test(c)) {
      break;
    }

    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < s.length && s[i] !== q) {
        // Inside double quotes, bash only treats \ before $ ` " \ as escapes.
        if (
          s[i] === '\\' &&
          q === '"' &&
          i + 1 < s.length &&
          /[$`"\\]/.test(s[i + 1]!)
        ) {
          i += 2;
        } else {
          i++;
        }
      }
      if (i < s.length) {
        i++; // closing quote
      }
      continue;
    }

    if (c === '$' && s[i + 1] === '(') {
      i = skipDollarParen(s, i);
      continue;
    }
    if (c === '$' && s[i + 1] === '{') {
      i = skipDollarBrace(s, i);
      continue;
    }
    if (c === '`') {
      i = skipBacktick(s, i);
      continue;
    }
    if (c === '\\' && i + 1 < s.length) {
      i += 2;
      continue;
    }
    i++;
  }
  return i;
}

/**
 * Decode a shell word's quotes/escapes into the logical path/token text.
 * Inside double quotes, only bash-special escapes (`$`, `` ` ``, `"`, `\`) are consumed.
 */
function unquoteShellWord(word: string): string {
  let result = '';
  let i = 0;
  while (i < word.length) {
    const c = word[i]!;
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < word.length && word[i] !== q) {
        if (
          word[i] === '\\' &&
          q === '"' &&
          i + 1 < word.length &&
          /[$`"\\]/.test(word[i + 1]!)
        ) {
          result += word[i + 1];
          i += 2;
        } else {
          result += word[i];
          i++;
        }
      }
      if (i < word.length) {
        i++; // closing quote
      }
      continue;
    }
    if (c === '\\' && i + 1 < word.length) {
      result += word[i + 1];
      i += 2;
      continue;
    }
    result += c;
    i++;
  }
  return result;
}

/** JSON object keys that typically hold secrets in curl -d / --data bodies. */
const JSON_SECRET_KEYS = [
  'password',
  'passwd',
  'pass',
  'secret',
  'token',
  'api[_-]?key',
  'access[_-]?key',
  'auth',
  'credentials?',
  'bearer',
].join('|');

const JSON_SECRET_KEY = new RegExp(
  `(["'])(${JSON_SECRET_KEYS})\\1\\s*:\\s*(["'])((?:\\\\.|(?!\\3).)*)\\3`,
  'gi'
);

/** Same keys when the history line still has shell-escaped quotes: {\\"token\\":\\"x\\"}. */
const JSON_SECRET_KEY_ESCAPED = new RegExp(
  `\\\\"(${JSON_SECRET_KEYS})\\\\"\\s*:\\s*\\\\"((?:\\\\.|[^"\\\\])*)\\\\"`,
  'gi'
);

function redactJsonSecrets(command: string): string {
  let result = command.replace(JSON_SECRET_KEY, (_m, q1: string, key: string, q2: string) => {
    return `${q1}${key}${q1}:${q2}${REDACTED}${q2}`;
  });
  result = result.replace(JSON_SECRET_KEY_ESCAPED, (_m, key: string) => {
    return `\\"${key}\\":\\"${REDACTED}\\"`;
  });
  return result;
}

/**
 * Redact secret env assignments, consuming complete shell words as values
 * (quoted, concatenated, escaped, or with substitutions).
 */
function redactEnvAssignments(command: string): string {
  let result = '';
  let i = 0;
  const s = command;

  while (i < s.length) {
    if (canStartAssignment(s, i)) {
      const rest = s.slice(i);
      // PowerShell: $env:API_KEY=hunter2
      const ps = rest.match(/^(\$env:)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)/i);
      if (ps && SECRET_ENV_NAME.test(ps[2]!)) {
        const valueStart = i + ps[0].length;
        const valueEnd = skipShellWord(s, valueStart);
        result += `${ps[1]}${ps[2]}=${REDACTED}`;
        i = valueEnd;
        continue;
      }
      const m = rest.match(/^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)/);
      if (m && SECRET_ENV_NAME.test(m[2]!)) {
        const valueStart = i + m[0].length;
        const valueEnd = skipShellWord(s, valueStart);
        const exportPrefix = m[1] ?? '';
        result += `${exportPrefix}${m[2]}=${REDACTED}`;
        i = valueEnd;
        continue;
      }
    }
    result += s[i];
    i++;
  }
  return result;
}

/**
 * Skip leading shell VAR=value assignments, including quoted values and substitutions.
 * Also skips PowerShell `$env:NAME=value` (with optional trailing `;`).
 */
function skipLeadingAssignments(command: string): string {
  let i = 0;
  const s = command;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) {
      i++;
    }
    const rest = s.slice(i);
    // PowerShell: $env:API_KEY="hunter2"; npm test
    const ps = rest.match(/^\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*/i);
    if (ps) {
      i += ps[0].length;
      i = skipShellWord(s, i);
      while (i < s.length && /\s/.test(s[i]!)) {
        i++;
      }
      if (s[i] === ';') {
        i++;
      }
      continue;
    }
    const m = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!m) {
      break;
    }
    i += m[0].length;
    i = skipShellWord(s, i);
  }
  return s.slice(i).trimStart();
}

/**
 * Extract argv0 (command name) from a shell command line.
 * Strips env assignments and path prefixes: `FOO=1 /usr/bin/npm run` → `npm`
 * Quotes and escapes are honored so `"/path with spaces/bin/tool"` → `tool`.
 */
export function extractArgv0(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return '';
  }

  const withoutEnv = skipLeadingAssignments(trimmed);
  if (!withoutEnv) {
    return '';
  }

  const firstEnd = skipShellWord(withoutEnv, 0);
  const firstRaw = withoutEnv.slice(0, firstEnd);
  // Command substitutions used as argv0 must not leak their source text/args.
  if (/^\$\(/.test(firstRaw) || /^`/.test(firstRaw)) {
    return '[cmd]';
  }
  const first = unquoteShellWord(firstRaw);
  // Drop path: /usr/bin/npm → npm, .\foo.cmd → foo.cmd
  const base = first.replace(/^.*[/\\]/, '');
  return base || first;
}

/**
 * Redact Authorization / X-Api-Key / X-Auth-Token header values, including
 * multi-word and unrecognized schemes inside quoted `-H` arguments
 * (e.g. `Authorization: token hunter2`).
 */
function redactAuthHeaders(command: string): string {
  let result = '';
  let last = 0;
  AUTH_HEADER_NAME.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AUTH_HEADER_NAME.exec(command)) !== null) {
    let j = m.index + m[0].length;
    while (j < command.length && /\s/.test(command[j]!)) {
      j++;
    }
    if (j >= command.length || (command[j] !== ':' && command[j] !== '=')) {
      continue;
    }
    j++; // consume : or =
    while (j < command.length && /\s/.test(command[j]!)) {
      j++;
    }
    const scheme = command.slice(j).match(/^(Bearer|Basic)\s+/i);
    if (scheme) {
      j += scheme[0].length;
    }

    // Prefer enclosing quote from `-H 'Authorization: …'` / `-H "…"`.
    let enclosing: string | undefined;
    for (let k = m.index - 1; k >= 0; k--) {
      const c = command[k]!;
      if (c === "'" || c === '"') {
        enclosing = c;
        break;
      }
      if (!/\s/.test(c)) {
        break;
      }
    }

    if (enclosing) {
      while (j < command.length && command[j] !== enclosing) {
        j++;
      }
    } else if (command[j] === "'" || command[j] === '"') {
      j = skipShellWord(command, j);
    } else {
      // Unquoted multi-word value: stop before next flag or URL.
      while (j < command.length) {
        if (command[j] === "'" || command[j] === '"') {
          break;
        }
        if (/\s/.test(command[j]!)) {
          const ws = command.slice(j).match(/^\s+/)?.[0].length ?? 0;
          const next = command.slice(j + ws);
          if (!next || /^-/.test(next) || /^https?:\/\//i.test(next)) {
            break;
          }
        }
        j++;
      }
    }

    result += command.slice(last, m.index);
    result += `${m[0]}: ${REDACTED}`;
    last = j;
    AUTH_HEADER_NAME.lastIndex = j;
  }
  result += command.slice(last);
  return result;
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
 * Consume a flag value that may be quoted, concatenated, or escaped
 * (e.g. `--password correct\ horse` or `--password "a b"`).
 * Returns the index just past the value.
 */
function skipFlagValue(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i]!)) {
    i++;
  }
  if (i >= s.length) {
    return i;
  }
  return skipShellWord(s, i);
}

/**
 * Redact secret CLI flags, including quoted values with whitespace
 * (e.g. `--password "correct horse battery staple"`).
 */
function redactSecretFlags(command: string): string {
  let result = '';
  let i = 0;
  const s = command;

  while (i < s.length) {
    // Preserve leading whitespace for this token region
    if (/\s/.test(s[i]!)) {
      result += s[i];
      i++;
      continue;
    }

    const rest = s.slice(i);
    const flagMatch = rest.match(SECRET_FLAG_PREFIX);
    if (!flagMatch) {
      // Copy until next whitespace (ordinary token)
      while (i < s.length && !/\s/.test(s[i]!)) {
        result += s[i];
        i++;
      }
      continue;
    }

    const flag = flagMatch[1]!;
    let j = i + flag.length;

    // Single-letter flags like `-pPASSWORD` / `-uadmin:hunter2` are compact forms.
    // Glued `-uuser:password` (curl) is redacted here; plain `-uroot` (mysql user) is left.
    // Glued `-p"correct horse"` must consume a full shell word so the passphrase cannot leak.
    const isSingleLetter = /^-[pu]$/i.test(flag);
    if (isSingleLetter && j < s.length && !/[\s=]/.test(s[j]!)) {
      if (/^-u$/i.test(flag)) {
        const valueStart = j;
        while (j < s.length && !/\s/.test(s[j]!)) {
          j++;
        }
        const glued = s.slice(valueStart, j);
        if (glued.includes(':')) {
          result += `${flag}${REDACTED}`;
          i = j;
          continue;
        }
      }
      if (/^-p$/i.test(flag)) {
        const valueEnd = skipShellWord(s, j);
        result += `${flag}${REDACTED}`;
        i = valueEnd;
        continue;
      }
      while (i < s.length && !/\s/.test(s[i]!)) {
        result += s[i];
        i++;
      }
      continue;
    }

    // `--password=value` or `--password value` / `--password "quoted value"`
    if (s[j] === '=') {
      j++;
      j = skipFlagValue(s, j);
      result += `${flag}=${REDACTED}`;
      i = j;
      continue;
    }

    if (j < s.length && /\s/.test(s[j]!)) {
      const valueStart = j + (s.slice(j).match(/^\s*/)?.[0].length ?? 0);
      if (valueStart < s.length) {
        const afterValue = skipFlagValue(s, j);
        result += `${flag}=${REDACTED}`;
        i = afterValue;
        continue;
      }
    }

    // Flag with no value — leave as-is
    result += flag;
    i = j;
  }

  return result;
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

  // Bound input early so multi-megabyte pastes cannot stall the extension host.
  // Keep a small margin over maxLen so near-limit secrets can still be redacted.
  const inputBudget = Math.max(maxLen * 8, 512);
  if (result.length > inputBudget) {
    result = result.slice(0, inputBudget);
  }

  result = redactEnvAssignments(result);
  result = redactAuthHeaders(result);
  result = redactSecretFlags(result);

  // Compact -pPASSWORD (including numeric passwords like -p123456).
  // Spaced forms such as `ps -p 123` are handled above / left as process selectors.
  result = result.replace(COMPACT_PASSWORD_FLAG, () => ` -p${REDACTED}`);

  result = redactJsonSecrets(result);

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
