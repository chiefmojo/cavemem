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
export { codexMcpMode, codexWslWarning } from './codex.js';
export { findForeignBridges } from './opencode.js';
