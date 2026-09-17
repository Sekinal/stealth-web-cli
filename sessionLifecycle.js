// @ts-check
const fs = require('fs');
const os = require('os');
const path = require('path');

/** @param {string} name @param {number} fallback @returns {number} */
function setting(name, fallback) {
  const value = process.env[name];
  const number = value === undefined ? fallback : Number(value);
  if (!value?.trim() && value !== undefined || !Number.isFinite(number) || number < 0)
    throw new Error(`${name} must be a non-negative number (0 disables it).`);
  return number;
}

/** @returns {string} */
function registryDirectory() {
  return path.join(process.env.PWTEST_DAEMON_SESSION_DIR || path.join(os.tmpdir(), `stealth-web-cli-${os.userInfo().username}`), 'managed-sessions');
}

/** @param {number} pid @returns {boolean} */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/**
 * Count only daemons started by this package; stale records never cause a
 * signal to an unrelated/reused PID. Expiry is enforced inside the daemon.
 * @param {string} directory
 * @returns {Array<{pid: number, name: string}>}
 */
function liveSessions(directory) {
  const result = [];
  for (const file of fs.readdirSync(directory)) {
    if (!file.endsWith('.json'))
      continue;
    const location = path.join(directory, file);
    try {
      const record = JSON.parse(fs.readFileSync(location, 'utf8'));
      if (!Number.isInteger(record.pid) || record.pid <= 0)
        continue;
      if (isAlive(record.pid))
        result.push(record);
      else
        fs.rmSync(location, { force: true });
    } catch (error) {
      // Concurrent daemon exit can remove a record during enumeration.
      if (error.code !== 'ENOENT')
        throw error;
    }
  }
  return result;
}

/**
 * Install lifecycle handling around the existing upstream daemon launcher.
 * Attached browsers retain their existing ownership and lifetime semantics.
 * @param {{Session: {startDaemon: Function}}} sessionModule
 */
function configureSessionLifecycle(sessionModule) {
  const original = sessionModule.Session.startDaemon;
  sessionModule.Session.startDaemon = async function(clientInfo, args, ...rest) {
    if (args.cdp || args.endpoint || args.extension)
      return original.call(this, clientInfo, args, ...rest);
    const idleSeconds = setting('PLAYWRIGHT_CLI_IDLE_TIMEOUT', 1800);
    const warningThreshold = setting('PLAYWRIGHT_CLI_SESSION_WARNING_THRESHOLD', 8);
    const directory = registryDirectory();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const previousOptions = process.env.NODE_OPTIONS;
    const previousLifecycle = process.env.STEALTH_CLI_LIFECYCLE;
    process.env.NODE_OPTIONS = `${previousOptions || ''} --require=${JSON.stringify(require.resolve('./sessionLifecyclePreload'))}`;
    process.env.STEALTH_CLI_LIFECYCLE = JSON.stringify({ directory, idleSeconds, daemonProfilesDir: clientInfo.daemonProfilesDir });
    let result;
    try {
      result = await original.call(this, clientInfo, args, ...rest);
    } finally {
      restoreEnvironment('NODE_OPTIONS', previousOptions);
      restoreEnvironment('STEALTH_CLI_LIFECYCLE', previousLifecycle);
    }
    const sessions = liveSessions(directory);
    if (warningThreshold && sessions.length >= warningThreshold) {
      console.error(`[stealth-web-cli] Warning: ${sessions.length} managed browser sessions are running (${sessions.map(session => session.name).join(', ')}). Close unused sessions with -s=<name> close, or close-all in their workspace; list --all discovers sessions across workspaces. New sessions are still allowed.`);
    }
    return result;
  };
}

module.exports = { configureSessionLifecycle };

/** @param {string} key @param {string | undefined} value */
function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
