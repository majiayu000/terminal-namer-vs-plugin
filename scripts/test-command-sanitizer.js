/**
 * Focused unit checks for commandSanitizer (runs against compiled out/).
 * Run: npm run compile && npm run test:sanitizer
 */
const {
  extractArgv0,
  sanitizeCommand,
  sanitizeCommands,
} = require('../out/core/commandSanitizer');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertIncludes(haystack, needle, message) {
  assert(haystack.includes(needle), message);
}

function assertNotIncludes(haystack, needle, message) {
  assert(!haystack.includes(needle), message);
}

console.log('commandSanitizer');

{
  console.log('\nexport TOKEN=');
  const out = sanitizeCommand('export TOKEN=supersecret123 npm run start');
  assertIncludes(out, '[REDACTED]', 'redacts export TOKEN value');
  assertNotIncludes(out, 'supersecret123', 'removes token value');
  assertIncludes(out, 'npm run start', 'keeps remaining command');
}

{
  console.log('\nquoted env secret with whitespace');
  const out = sanitizeCommand('export API_KEY="correct horse battery staple" npm test');
  assertIncludes(out, '[REDACTED]', 'redacts quoted API_KEY with spaces');
  assertNotIncludes(out, 'correct horse', 'removes passphrase words');
  assertIncludes(out, 'npm test', 'keeps remaining command after quoted assignment');
}

{
  console.log('\nAuthorization headers');
  const out = sanitizeCommand(
    "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig' https://api.example.com"
  );
  assertIncludes(out, '[REDACTED]', 'redacts Authorization header');
  assertNotIncludes(out, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'removes bearer token');
}

{
  console.log('\n-p / --password flags');
  const mysql = sanitizeCommand('mysql -uroot -pSecretPass123 mydb');
  assertIncludes(mysql, '[REDACTED]', 'redacts compact -pPASSWORD');
  assertNotIncludes(mysql, 'SecretPass123', 'removes mysql password');

  const flagged = sanitizeCommand('mycli --password=hunter2 query');
  assertIncludes(flagged, '[REDACTED]', 'redacts --password=');
  assertNotIncludes(flagged, 'hunter2', 'removes --password value');

  const spaced = sanitizeCommand('tool --password "s3cret!" do-it');
  assertIncludes(spaced, '[REDACTED]', 'redacts --password with space');
  assertNotIncludes(spaced, 's3cret!', 'removes spaced password');
}

{
  console.log('\ncurl -u / --user credentials');
  const short = sanitizeCommand('curl -u admin:hunter2 https://example.com');
  assertIncludes(short, '[REDACTED]', 'redacts curl -u credentials');
  assertNotIncludes(short, 'hunter2', 'removes curl -u password');

  const long = sanitizeCommand('curl --user admin:hunter2 https://example.com');
  assertIncludes(long, '[REDACTED]', 'redacts curl --user credentials');
  assertNotIncludes(long, 'hunter2', 'removes curl --user password');
}

{
  console.log('\nempty-username credential URLs');
  const out = sanitizeCommand('REDIS_URL=redis://:hunter2@localhost/0 redis-cli');
  assertIncludes(out, '[REDACTED]', 'redacts empty-user URL password');
  assertNotIncludes(out, 'hunter2', 'removes redis URL password');
}

{
  console.log('\nhigh-entropy tokens');
  const sk = sanitizeCommand(
    'curl https://api.openai.com -H "Authorization: Bearer sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"'
  );
  assertNotIncludes(sk, 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF', 'redacts sk- style key');

  const hex = sanitizeCommand(
    'deploy --token a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
  );
  assertIncludes(hex, '[REDACTED]', 'redacts long hex/token via --token');
  assertNotIncludes(
    hex,
    'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    'removes high-entropy token value'
  );

  const withSlash = sanitizeCommand(
    'echo j4BI4fUN7ehtTXbsQYU/V0DZ579peci7ZGB9boNBv8o='
  );
  assertIncludes(withSlash, '[REDACTED]', 'redacts high-entropy base64 containing slash');
  assertNotIncludes(withSlash, 'j4BI4fUN7ehtTXbsQYU/V0DZ579peci7ZGB9boNBv8o=', 'removes base64 with slash');
}

{
  console.log('\nper-command length cap');
  const long = 'echo ' + 'x'.repeat(200);
  const out = sanitizeCommand(long, { maxCommandLength: 40 });
  assert(out.length <= 41, `caps length (got ${out.length})`);
  assert(out.endsWith('…'), 'adds ellipsis when truncated');
}

{
  console.log('\nargv0-only mode');
  assert(
    sanitizeCommand('npm run dev -- --port 3000', { argv0Only: true }) === 'npm',
    'argv0Only keeps npm'
  );
  assert(
    sanitizeCommand('/usr/local/bin/python3 train.py --secret=abc', { argv0Only: true }) ===
      'python3',
    'argv0Only strips path and args'
  );
  assert(extractArgv0('FOO=1 BAR=2 docker compose up') === 'docker', 'extractArgv0 skips env');
  assert(
    extractArgv0('FOO="secret phrase" npm run dev') === 'npm',
    'extractArgv0 skips quoted assignment with spaces'
  );
  assert(
    sanitizeCommand('FOO="secret phrase" npm run dev', { argv0Only: true }) === 'npm',
    'argv0Only does not leak quoted assignment fragments'
  );
}

{
  console.log('\nsanitizeCommands batch');
  const out = sanitizeCommands([
    'export API_KEY=abcd1234 npm test',
    '',
    'ls -la',
  ]);
  assert(out.length === 2, 'drops empty commands');
  assertNotIncludes(out[0], 'abcd1234', 'batch redacts secrets');
  assert(out[1] === 'ls -la', 'keeps safe commands intact');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
