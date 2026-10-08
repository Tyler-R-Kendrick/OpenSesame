import {
  installTrayNoticePersistence,
  restoreTrayNoticeHistory,
} from "@opensesame/app-core/lib/notice-tray-persist.js";

/** Seal tray history and restore it once the at-rest key is ready (ADR 0163). */
export function bootTrayNotices(): void {
  installTrayNoticePersistence();
  void restoreTrayNoticeHistory();
}
