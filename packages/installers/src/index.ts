export {
  installers,
  getInstaller,
  type IdeName,
  type Installer,
  type CaptureLevel,
} from './registry.js';
export {
  checkWindowsSh,
  resolveShDefault,
  WINDOWS_SH_MISSING_WARNING,
  type CheckWindowsShOptions,
} from './windows-sh.js';
export { CODEX_TOKEN_ENV, codexMcpMode, codexWslWarning } from './codex.js';
export {
  readUserEnvDefault,
  syncWindowsUserEnvVar,
  writeUserEnvDefault,
  type WindowsUserEnvSyncResult,
} from './windows-env.js';
export { findForeignBridges } from './opencode.js';
