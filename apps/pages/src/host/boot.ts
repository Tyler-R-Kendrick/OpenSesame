/**
 * Installs the browser host before any part of the shared core runs
 * (ADR 0133). main.tsx imports this module first, so module evaluation order
 * guarantees the host exists before the app's own modules load.
 */
import { configureHost } from "@opensesame/app-core/host.js";

configureHost({ env: import.meta.env });
