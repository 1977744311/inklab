// 命令行共用：版本号与各命令的用法。用法串只在这里写一份，--help 与参数缺失时的提示都引用它。
import { readFileSync } from 'node:fs';

// 测试会把 bin/ 与 lib/ 拷到临时目录单独运行（没有 package.json），读不到时不影响命令本身。
export const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; }
  catch { return 'unknown'; }
})();

export const USAGE = {
  inklab: '用法: inklab <app-dir|package.aix> [--compare-with <dir|package.aix>] [--port 8788] [--open] [--players 1–6] [--allow-external pattern] [--device --serial SN --device-output DIR]',
  'inklab-e2e': '用法: inklab-e2e <app-dir|package.aix> [--scenario id] [--runtime latest|daily|studio|<lane>] [--preview studio|optical] [--lighting id] [--report-dir path] [--accept] [--llm off|live|record|replay] [--headed] [--no-video]',
  'inklab-matrix': '用法: inklab-matrix <app-dir|package.aix> [--scenario id] [--runtime latest|daily|studio|<lane>] [--all-lighting]',
  'inklab-engine': '用法: inklab-engine [lane ...] [--check] [--discover] [--list [--json]]',
  'inklab-device': '用法: inklab-device info | push <app-dir|pkg.aix> [--page P] [--imu real|replay|record] [--trace NAME[#SEG]] [--loop] | open <app-dir> | --agent ID [--page P] | exit | gesture <tap|double-tap|long-press|forward|backward|wake> | agents  [--serial SN]\n      inklab-device imu-guide [app-dir] [--name NAME] | imu-record <app-dir> --name NAME [--seconds N] [--push]\n      inklab-device <app-dir> --serial SN --scenario ID [--scenario ID] [--out DIR] | <app-dir> --list',
};

/** 处理 --help/-h 与 --version/-V。处理了就返回 true，调用方直接结束。 */
export function handleMeta(command, argv, { log = console.log } = {}) {
  if (argv.includes('--version') || argv.includes('-V')) { log(VERSION); return true; }
  if (argv.includes('--help') || argv.includes('-h')) { log(USAGE[command]); return true; }
  return false;
}
