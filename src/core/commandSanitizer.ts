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

/** Authorization / Bearer / Basic / X-Api-Key / Cookie style header names */
const AUTH_HEADER_NAME = /(?:Authorization|X-Api-Key|X-Auth-Token|Cookie)/gi;

/** Common password / token / user / cookie CLI flags with their values */
const SECRET_FLAG_NAMES =
  '-p|--password|--passwd|--pass|--secret|--token|--api[-_]?key|--access[-_]?key|--auth|-u|--user|-b|--cookie';

const SECRET_FLAG_EXACT = new RegExp(`^(${SECRET_FLAG_NAMES})$`, 'i');

/**
 * Commands where short `-p` / `-u` typically carry credentials (not python -u, sort -u, …).
 * `docker` is limited to `docker login` so `docker compose -p project` stays intact.
 */
const CREDENTIAL_SHORT_FLAG_COMMANDS =
  /(^|[\s/\\])(?:curl|wget|mysql|mysqldump|mariadb|psql|pg_dump|mongo|mongosh|redis-cli|mycli|sshpass|docker(?=\s+login\b))(?=\s|$)/i;

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
 * Advance past a balanced `(...)` group starting at `i` (s[i] === '(').
 * Used for array assignments and process-substitution operands.
 */
function skipBalancedParen(s: string, i: number): number {
  // s[i] === '('
  i++;
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
      i = skipDollarParen(s, i);
      continue;
    }
    if (c === '$' && s[i + 1] === '{') {
      i = skipDollarBrace(s, i);
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

export type SkipShellWordOptions = {
  /** When true, unquoted `;` ends the word (PowerShell statement separator). */
  stopAtSemicolon?: boolean;
};

/**
 * Advance past one shell word: quoted segments (with internal whitespace),
 * concatenations such as `correct" horse battery"`, escapes (`a\ b`),
 * `$()` / `${...}` / `` ` `` substitutions, and parenthesized groups.
 * Unquoted whitespace ends the word.
 */
function skipShellWord(s: string, i: number, options: SkipShellWordOptions = {}): number {
  if (i >= s.length || /\s/.test(s[i]!)) {
    return i;
  }

  // Lone statement/pipeline separators are one-character tokens so callers
  // (flag/env scanners) always advance past them.
  const lead = s[i]!;
  if (lead === ';' || lead === '&' || lead === '|') {
    if ((lead === '&' || lead === '|') && s[i + 1] === lead) {
      return i + 2;
    }
    return i + 1;
  }

  while (i < s.length) {
    const c = s[i]!;

    // Unquoted whitespace terminates the word
    if (/\s/.test(c)) {
      break;
    }
    // Unquoted statement/pipeline separators end the word (bash and PowerShell).
    if (c === ';' || c === '&' || c === '|') {
      break;
    }
    if (options.stopAtSemicolon && c === ';') {
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
    // Process substitution `<(...)` / `>(...)` and array `(...)` groups.
    if ((c === '<' || c === '>') && s[i + 1] === '(') {
      i = skipBalancedParen(s, i + 1);
      continue;
    }
    if (c === '(') {
      i = skipBalancedParen(s, i);
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
  `(["'])(${JSON_SECRET_KEYS})\\1\\s*:\\s*(?:(["'])((?:\\\\.|(?!\\3).)*)\\3|(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|true|false|null))`,
  'gi'
);

/** Same keys when the history line still has shell-escaped quotes: {\\"token\\":\\"x\\"}. */
const JSON_SECRET_KEY_ESCAPED = new RegExp(
  `\\\\"(${JSON_SECRET_KEYS})\\\\"\\s*:\\s*(?:\\\\"((?:\\\\.|[^"\\\\])*)\\\\"|(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|true|false|null))`,
  'gi'
);

function redactJsonSecrets(command: string): string {
  let result = command.replace(
    JSON_SECRET_KEY,
    (_m, q1: string, key: string, q2: string | undefined) => {
      if (q2) {
        return `${q1}${key}${q1}:${q2}${REDACTED}${q2}`;
      }
      return `${q1}${key}${q1}:${REDACTED}`;
    }
  );
  result = result.replace(JSON_SECRET_KEY_ESCAPED, (_m, key: string, strVal: string | undefined) => {
    if (strVal !== undefined) {
      return `\\"${key}\\":\\"${REDACTED}\\"`;
    }
    return `\\"${key}\\":${REDACTED}`;
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
        const valueEnd = skipShellWord(s, valueStart, { stopAtSemicolon: true });
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
      i = skipShellWord(s, i, { stopAtSemicolon: true });
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
    while (i < s.length && /\s/.test(s[i]!)) {
      i++;
    }
    if (s[i] === ';') {
      i++;
    }
  }
  return s.slice(i).trimStart();
}

/**
 * Skip leading shell redirections (`>file`, `<in`, `>>log`, `2>err`, `&>out`, …)
 * and their operands so argv0 is the executable, not a redirected path.
 */
function skipLeadingRedirections(command: string): string {
  let i = 0;
  const s = command;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) {
      i++;
    }
    const rest = s.slice(i);
    // Optional fd number, then redirection operator.
    const redir = rest.match(/^(\d*)(?:>>|&>|>&|<|>)/);
    if (!redir) {
      break;
    }
    i += redir[0].length;
    while (i < s.length && /\s/.test(s[i]!)) {
      i++;
    }
    // `>&1` / `2>&1` style — digit already consumed as part of op when `>&`.
    // If operand remains, consume one shell word.
    if (i < s.length && !/[;&|]/.test(s[i]!)) {
      // Bare `>&1` already matched via `>&` + digit left; if next is a digit-only
      // fd with no further path, skipShellWord still advances one token.
      i = skipShellWord(s, i);
    }
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

  const withoutRedirs = skipLeadingRedirections(withoutEnv);
  if (!withoutRedirs) {
    return '';
  }

  const firstEnd = skipShellWord(withoutRedirs, 0);
  const firstRaw = withoutRedirs.slice(0, firstEnd);
  // Command substitutions anywhere in argv0 must not leak their source text/args.
  if (/\$\(|`|\$\{/.test(firstRaw)) {
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
 * Redact secret CLI flags, including quoted option names and values
 * (e.g. `"--password" "correct horse"` or `--pass"word" hunter2`).
 */
function redactSecretFlags(command: string): string {
  let result = '';
  let i = 0;
  const s = command;
  const credentialCommand = CREDENTIAL_SHORT_FLAG_COMMANDS.test(s);

  while (i < s.length) {
    if (/\s/.test(s[i]!)) {
      result += s[i];
      i++;
      continue;
    }

    const wordEnd = skipShellWord(s, i);
    const wordRaw = s.slice(i, wordEnd);
    const word = unquoteShellWord(wordRaw);
    const eqIdx = word.indexOf('=');

    let flag: string | undefined;
    let gluedValue: string | undefined;

    if (eqIdx >= 0) {
      const flagPart = word.slice(0, eqIdx);
      if (SECRET_FLAG_EXACT.test(flagPart)) {
        flag = flagPart;
        gluedValue = word.slice(eqIdx + 1);
      }
    } else if (SECRET_FLAG_EXACT.test(word)) {
      flag = word;
    } else {
      const glued = word.match(/^(-[pub])(.+)$/i);
      if (glued) {
        flag = glued[1]!;
        gluedValue = glued[2]!;
      }
    }

    if (!flag) {
      result += wordRaw;
      i = wordEnd;
      continue;
    }

    const isShortCred = /^-[pub]$/i.test(flag);

    // Short flags on non-credential commands: only redact glued curl `-uuser:pass`.
    // Do not treat `-print` / `python -u` / `sort -u` as secrets.
    if (isShortCred && !credentialCommand) {
      if (/^-u$/i.test(flag) && gluedValue !== undefined && gluedValue.includes(':')) {
        result += `${flag}${REDACTED}`;
        i = wordEnd;
        continue;
      }
      result += wordRaw;
      i = wordEnd;
      continue;
    }

    if (eqIdx >= 0) {
      result += `${flag}=${REDACTED}`;
      i = wordEnd;
      continue;
    }

    if (gluedValue !== undefined) {
      if (/^-u$/i.test(flag)) {
        if (gluedValue.includes(':')) {
          result += `${flag}${REDACTED}`;
        } else {
          // mysql `-uroot` (user only) — keep
          result += wordRaw;
        }
        i = wordEnd;
        continue;
      }
      // `-pPASSWORD`, `-bsession=…`
      result += `${flag}${REDACTED}`;
      i = wordEnd;
      continue;
    }

    // Spaced value: `--password value`, `-b cookie`, curl `-u user:pass`
    let j = wordEnd;
    if (j < s.length && /\s/.test(s[j]!)) {
      const valueStart = j + (s.slice(j).match(/^\s*/)?.[0].length ?? 0);
      if (valueStart < s.length) {
        const afterValue = skipFlagValue(s, j);
        result += `${flag}=${REDACTED}`;
        i = afterValue;
        continue;
      }
    }

    result += wordRaw;
    i = wordEnd;
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

  // Compact -pPASSWORD (including numeric passwords like -p123456) only on
  // credential-oriented commands so `find -print` / `sort -u` stay intact.
  // Spaced forms such as `ps -p 123` are left as process selectors.
  if (CREDENTIAL_SHORT_FLAG_COMMANDS.test(result)) {
    result = result.replace(COMPACT_PASSWORD_FLAG, () => ` -p${REDACTED}`);
  }

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
