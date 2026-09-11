/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// @ts-check

const fs = require('fs');
const path = require('path');

/**
 * The bundled skill is this package's own customized skill (fetch/scrape and
 * the stealth CLI instructions), not playwright-core's upstream copy
 * (issue #64).
 * @returns {string}
 */
function bundledSkillDir() {
  return path.join(__dirname, 'skills', 'playwright-cli');
}

/**
 * @returns {string}
 */
function bundledSkillFile() {
  return path.join(bundledSkillDir(), 'SKILL.md');
}

/**
 * Copy this package's bundled skill (SKILL.md + references) into the requested
 * target, instead of letting upstream install playwright-core's copy (#64).
 * @param {string | undefined} target 'agents' or undefined/anything else for claude
 */
function installBundledSkill(target) {
  const cwd = process.cwd();
  const dir = target === 'agents'
    ? path.join(cwd, '.agents', 'skills', 'playwright-cli')
    : path.join(cwd, '.claude', 'skills', 'playwright-cli');
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(bundledSkillDir(), dir, { recursive: true });
  console.log(`Installed the stealth-web-cli skill to ${path.relative(cwd, dir) || dir}`);
}

function installedSkillTargets() {
  const cwd = process.cwd();
  return [
    { dir: path.join(cwd, '.claude', 'skills', 'playwright-cli'), command: 'stealth-web-cli install --skills' },
    { dir: path.join(cwd, '.agents', 'skills', 'playwright-cli'), command: 'stealth-web-cli install --skills=agents' },
  ];
}

/**
 * @param {string} file
 * @returns
 */
function readSkill(file) {
  // Normalize line endings, they could be affected by git or editor settings.
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
}

/**
 * @param {string[]} lines
 * @returns {string}
 */
function frame(lines) {
  const width = Math.max(...lines.map(line => line.length));
  const top = '╔' + '═'.repeat(width + 2) + '╗';
  const bottom = '╚' + '═'.repeat(width + 2) + '╝';
  const body = lines.map(line => `║ ${line.padEnd(width)} ║`);
  return [top, ...body, bottom].join('\n') + '\n';
}

function checkInstalledSkills() {
  try {
    const bundled = readSkill(bundledSkillFile());
    if (!bundled)
      return;
    for (const target of installedSkillTargets()) {
      const installed = readSkill(path.join(target.dir, 'SKILL.md'));
      if (installed === null)
        continue;
      if (installed !== bundled) {
        process.stderr.write(frame([
          `The installed CLI skill at '${path.relative(process.cwd(), target.dir)}'`,
          `does not match the tool version.`,
          ``,
          `Run \`${target.command}\``,
          `to install the up-to-date skill.`,
        ]));
      }
    }
  } catch {
  }
}

module.exports = { checkInstalledSkills, frame, installBundledSkill };
