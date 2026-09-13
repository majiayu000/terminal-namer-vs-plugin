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

  const compound = sanitizeCommand('API_KEY=correct" horse battery" npm test');
  assertIncludes(compound, '[REDACTED]', 'redacts compound quoted API_KEY assignment');
  assertNotIncludes(compound, 'horse', 'removes compound quoted fragments');
  assertNotIncludes(compound, 'battery', 'removes compound quoted tail');
  assertIncludes(compound, 'npm test', 'keeps command after compound assignment');
}

{
  console.log('\nAuthorization headers');
  const out = sanitizeCommand(
    "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig' https://api.example.com"
  );
  assertIncludes(out, '[REDACTED]', 'redacts Authorization header');
  assertNotIncludes(out, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'removes bearer token');

  const tokenScheme = sanitizeCommand(
    "curl -H 'Authorization: token hunter2' https://api.example.com"
  );
  assertIncludes(tokenScheme, '[REDACTED]', 'redacts unrecognized Authorization scheme');
  assertNotIncludes(tokenScheme, 'hunter2', 'removes multi-word Authorization value');
  assertNotIncludes(tokenScheme, 'token hunter2', 'does not leave scheme+secret after redaction');

  const apiKeyWs = sanitizeCommand("curl -H 'X-Api-Key: correct horse' https://api.example.com");
  assertIncludes(apiKeyWs, '[REDACTED]', 'redacts X-Api-Key with whitespace');
  assertNotIncludes(apiKeyWs, 'horse', 'removes X-Api-Key passphrase tail');
}

{
  console.log('\n-p / --password flags');
  const mysql = sanitizeCommand('mysql -uroot -pSecretPass123 mydb');
  assertIncludes(mysql, '[REDACTED]', 'redacts compact -pPASSWORD');
  assertNotIncludes(mysql, 'SecretPass123', 'removes mysql password');

  const numeric = sanitizeCommand('mysql -uroot -p123456 mydb');
  assertIncludes(numeric, '[REDACTED]', 'redacts numeric compact -pPASSWORD');
  assertNotIncludes(numeric, '123456', 'removes numeric mysql password');

  const gluedQuoted = sanitizeCommand('mysql -uroot -p"correct horse" mydb');
  assertIncludes(gluedQuoted, '[REDACTED]', 'redacts glued quoted compact -p password');
  assertNotIncludes(gluedQuoted, 'correct', 'removes glued quoted password head');
  assertNotIncludes(gluedQuoted, 'horse', 'removes glued quoted password tail');
  assertIncludes(gluedQuoted, 'mydb', 'keeps trailing args after glued quoted -p');

  const flagged = sanitizeCommand('mycli --password=hunter2 query');
  assertIncludes(flagged, '[REDACTED]', 'redacts --password=');
  assertNotIncludes(flagged, 'hunter2', 'removes --password value');

  const spaced = sanitizeCommand('tool --password "s3cret!" do-it');
  assertIncludes(spaced, '[REDACTED]', 'redacts --password with space');
  assertNotIncludes(spaced, 's3cret!', 'removes spaced password');

  const quotedPassphrase = sanitizeCommand(
    'tool --password "correct horse battery staple" run'
  );
  assertIncludes(quotedPassphrase, '[REDACTED]', 'redacts quoted passphrase flag value');
  assertNotIncludes(quotedPassphrase, 'correct horse', 'removes quoted passphrase words');
  assertIncludes(quotedPassphrase, 'run', 'keeps trailing args after quoted flag');

  const escapedWs = sanitizeCommand('tool --password correct\\ horse run');
  assertIncludes(escapedWs, '[REDACTED]', 'redacts escaped-whitespace password flag');
  assertNotIncludes(escapedWs, 'horse', 'removes escaped password fragment');
  assertIncludes(escapedWs, 'run', 'keeps trailing args after escaped flag value');
}

{
  console.log('\ncurl -u / --user credentials');
  const short = sanitizeCommand('curl -u admin:hunter2 https://example.com');
  assertIncludes(short, '[REDACTED]', 'redacts curl -u credentials');
  assertNotIncludes(short, 'hunter2', 'removes curl -u password');

  const long = sanitizeCommand('curl --user admin:hunter2 https://example.com');
  assertIncludes(long, '[REDACTED]', 'redacts curl --user credentials');
  assertNotIncludes(long, 'hunter2', 'removes curl --user password');

  const glued = sanitizeCommand('curl -uadmin:hunter2 https://example.com');
  assertIncludes(glued, '[REDACTED]', 'redacts glued curl -u credentials');
  assertNotIncludes(glued, 'hunter2', 'removes glued curl -u password');
  assertNotIncludes(glued, 'admin:', 'removes glued curl -u userinfo');
}

{
  console.log('\nbrace expansion assignments');
  const brace = sanitizeCommand(
    'API_KEY=${FALLBACK:-correct horse battery} npm test'
  );
  assertIncludes(brace, '[REDACTED]', 'redacts brace-expansion API_KEY assignment');
  assertNotIncludes(brace, 'correct', 'removes brace default secret head');
  assertNotIncludes(brace, 'horse', 'removes brace default secret mid');
  assertNotIncludes(brace, 'battery', 'removes brace default secret tail');
  assertIncludes(brace, 'npm test', 'keeps command after brace assignment');
  assert(
    extractArgv0('API_KEY=${FALLBACK:-correct horse battery} npm test') === 'npm',
    'extractArgv0 skips brace-expansion assignment'
  );
  assert(
    sanitizeCommand('API_KEY=${FALLBACK:-correct horse battery} npm test', {
      argv0Only: true,
    }) === 'npm',
    'argv0Only does not leak brace-expansion fragments'
  );
}

{
  console.log('\nquoted executable paths (argv0)');
  assert(
    extractArgv0('"/home/alice/Customer Secret/bin/deploy" --token hunter2') ===
      'deploy',
    'extractArgv0 keeps basename of quoted unix path with spaces'
  );
  assert(
    extractArgv0('"C:\\Users\\Alice Smith\\bin\\tool.exe" --token x') === 'tool.exe',
    'extractArgv0 keeps basename of quoted windows path with spaces'
  );
  assert(
    sanitizeCommand('"/home/alice/Customer Secret/bin/deploy" --token hunter2', {
      argv0Only: true,
    }) === 'deploy',
    'argv0Only does not leak quoted path directory fragments'
  );
}

{
  console.log('\nJSON request-body secrets');
  const jsonBody = sanitizeCommand(
    `curl -d '{"password":"hunter2"}' https://api.example.com/login`
  );
  assertIncludes(jsonBody, '[REDACTED]', 'redacts JSON password in -d body');
  assertNotIncludes(jsonBody, 'hunter2', 'removes JSON password value');
  assertIncludes(jsonBody, 'password', 'keeps JSON key name');

  const tokenBody = sanitizeCommand(
    `curl --data "{\\"token\\":\\"abc123secret\\"}" https://api.example.com`
  );
  assertIncludes(tokenBody, '[REDACTED]', 'redacts JSON token in --data body');
  assertNotIncludes(tokenBody, 'abc123secret', 'removes JSON token value');
}

{
  console.log('\nMYSQL_PWD / PGPASSWORD env secrets');
  const mysqlPwd = sanitizeCommand('MYSQL_PWD=hunter2 mysql -uroot');
  assertIncludes(mysqlPwd, '[REDACTED]', 'redacts MYSQL_PWD assignment');
  assertNotIncludes(mysqlPwd, 'hunter2', 'removes MYSQL_PWD value');
  assertIncludes(mysqlPwd, 'mysql -uroot', 'keeps mysql command');

  const pgPwd = sanitizeCommand('PGPASSWORD=s3cret psql -h localhost');
  assertIncludes(pgPwd, '[REDACTED]', 'redacts PGPASSWORD assignment');
  assertNotIncludes(pgPwd, 's3cret', 'removes PGPASSWORD value');

  // Bare PWD is a working-directory variable, not a credential name.
  const barePwd = sanitizeCommand('PWD=/tmp/workdir ls');
  assertNotIncludes(barePwd, '[REDACTED]', 'does not redact bare PWD');
  assertIncludes(barePwd, '/tmp/workdir', 'keeps working-directory PWD value');
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

  // Multi-megabyte paste must not scan the full input (bounded early).
  const huge = 'echo ' + '!'.repeat(5 * 1024 * 1024);
  const t0 = Date.now();
  const hugeOut = sanitizeCommand(huge, { maxCommandLength: 120 });
  const elapsed = Date.now() - t0;
  assert(hugeOut.length <= 121, `caps huge input length (got ${hugeOut.length})`);
  assert(elapsed < 2000, `huge input sanitizes quickly (took ${elapsed}ms)`);
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
  assert(
    extractArgv0("TOKEN=$(printf 'correct horse battery staple') npm test") === 'npm',
    'extractArgv0 skips assignment with command substitution'
  );
  assert(
    sanitizeCommand("TOKEN=$(printf 'correct horse battery staple') npm test", {
      argv0Only: true,
    }) === 'npm',
    'argv0Only does not leak substitution fragments'
  );
  assert(
    extractArgv0("TOKEN=`printf secret` npm test") === 'npm',
    'extractArgv0 skips backtick substitution assignment'
  );
  assert(
    extractArgv0('TOKEN=correct" horse battery" npm test') === 'npm',
    'extractArgv0 skips compound quoted assignment'
  );
  assert(
    sanitizeCommand('TOKEN=correct" horse battery" npm test', { argv0Only: true }) === 'npm',
    'argv0Only does not leak compound quoted assignment fragments'
  );
  assert(
    extractArgv0("$(printf 'Customer Secret') --token hunter2") === '[cmd]',
    'extractArgv0 replaces command-substitution executable with placeholder'
  );
  assert(
    sanitizeCommand("$(printf 'Customer Secret') --token hunter2", { argv0Only: true }) ===
      '[cmd]',
    'argv0Only does not leak command-substitution contents'
  );
  assert(
    extractArgv0('$env:API_KEY="hunter2"; npm test') === 'npm',
    'extractArgv0 skips PowerShell $env: assignment'
  );
  assert(
    sanitizeCommand('$env:API_KEY="hunter2"; npm test', { argv0Only: true }) === 'npm',
    'argv0Only does not leak PowerShell $env: secret'
  );
  assertNotIncludes(
    sanitizeCommand('$env:API_KEY="hunter2"; npm test'),
    'hunter2',
    'sanitized mode redacts PowerShell $env: secret'
  );
  assert(
    extractArgv0('$env:API_KEY=hunter2;echo "Customer Secret"') === 'echo',
    'extractArgv0 stops PowerShell assignment at semicolon'
  );
  assertNotIncludes(
    sanitizeCommand('$env:API_KEY=hunter2;echo "Customer Secret"', { argv0Only: true }),
    'Customer Secret',
    'argv0Only does not leak args after PowerShell semicolon assignment'
  );
  assert(
    extractArgv0("prefix$(printf 'Customer Secret') --token hunter2") === '[cmd]',
    'extractArgv0 rejects concatenated substitution in argv0'
  );
  assert(
    extractArgv0('>"/tmp/Customer Secret.log" npm run dev') === 'npm',
    'extractArgv0 skips leading redirection'
  );
  assert(
    extractArgv0('<input-secret.txt python train.py') === 'python',
    'extractArgv0 skips leading input redirection'
  );
  assert(
    extractArgv0("API_KEY=(correct 'horse battery'); npm test") === 'npm',
    'extractArgv0 skips parenthesized array assignment'
  );
  assertNotIncludes(
    sanitizeCommand("API_KEY=(correct 'horse battery'); npm test"),
    'horse',
    'redacts parenthesized array assignment secrets'
  );
  assertNotIncludes(
    sanitizeCommand("API_KEY=<(printf 'correct horse'); npm test"),
    'horse',
    'redacts process-substitution assignment secrets'
  );
}

{
  console.log('\nquoted secret flag names');
  const quotedName = sanitizeCommand('tool "--password" hunter2 run');
  assertIncludes(quotedName, '[REDACTED]', 'redacts quoted --password flag name');
  assertNotIncludes(quotedName, 'hunter2', 'removes value after quoted flag name');
  assertIncludes(quotedName, 'run', 'keeps trailing args after quoted flag name');

  const composed = sanitizeCommand('tool --pass"word" hunter2 run');
  assertIncludes(composed, '[REDACTED]', 'redacts composed quoted secret flag name');
  assertNotIncludes(composed, 'hunter2', 'removes value after composed flag name');
}

{
  console.log('\nnumeric JSON secrets and cookies');
  const numericJson = sanitizeCommand(`curl -d '{"password":123456}' https://example.com`);
  assertIncludes(numericJson, '[REDACTED]', 'redacts numeric JSON password');
  assertNotIncludes(numericJson, '123456', 'removes numeric JSON password value');

  const cookieH = sanitizeCommand("curl -H 'Cookie: sessionid=hunter2' https://example.com");
  assertIncludes(cookieH, '[REDACTED]', 'redacts Cookie header');
  assertNotIncludes(cookieH, 'hunter2', 'removes Cookie header value');

  const cookieB = sanitizeCommand('curl -b sessionid=hunter2 https://example.com');
  assertIncludes(cookieB, '[REDACTED]', 'redacts curl -b cookie data');
  assertNotIncludes(cookieB, 'hunter2', 'removes curl -b cookie value');
}

{
  console.log('\nshort credential flags stay contextual');
  const pythonU = sanitizeCommand('python -u train.py');
  assertIncludes(pythonU, 'train.py', 'keeps python -u filename');
  assertNotIncludes(pythonU, '[REDACTED]', 'does not redact python -u');

  const sortU = sanitizeCommand('sort -u customers.txt');
  assertIncludes(sortU, 'customers.txt', 'keeps sort -u filename');
  assertNotIncludes(sortU, '[REDACTED]', 'does not redact sort -u');

  const findP = sanitizeCommand('find . -print');
  assertIncludes(findP, '-print', 'keeps find -print');
  assertNotIncludes(findP, '[REDACTED]', 'does not redact find -print as -p');

  const dockerLogin = sanitizeCommand('docker login -p hunter2');
  assertIncludes(dockerLogin, '[REDACTED]', 'redacts docker login -p');
  assertNotIncludes(dockerLogin, 'hunter2', 'removes docker login password');

  const dockerCompose = sanitizeCommand('docker compose -p myproject up');
  assertIncludes(dockerCompose, '-p myproject', 'keeps docker compose project -p');
  assertNotIncludes(dockerCompose, '[REDACTED]', 'does not redact docker compose -p');

  const sshpass = sanitizeCommand('sshpass -p hunter2 ssh host');
  assertIncludes(sshpass, '[REDACTED]', 'redacts sshpass -p');
  assertNotIncludes(sshpass, 'hunter2', 'removes sshpass password');
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
