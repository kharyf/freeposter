// The desktop app: FreePoster's server running inside Electron, shown in its own window.
import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray } from "electron";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { startApp, type RunningApp } from "./app.ts";
import { codeDir, config, dataDir, packaged } from "./config.ts";

// The installed app has no console, so its output goes to a log file next to the data.
if (packaged) {
  const logFile = join(dataDir, "freeposter.log");
  const write = (level: string) => (...args: unknown[]) => {
    try { appendFileSync(logFile, `${new Date().toISOString()} ${level} ${format(...args)}\n`); } catch {}
  };
  console.log = console.info = write("info");
  console.warn = console.error = write("error");
}

const origin = `http://localhost:${config.port}`;
const icon = nativeImage.createFromPath(join(codeDir, "icon.png"));
// Taskbar grouping and notifications under FreePoster's own name; must match appId in scripts/build-app.ts,
// the id the installer gives the Start menu shortcut.
app.setAppUserModelId("com.freeposter.app");
app.setPath("userData", join(dataDir, "window")); // keep Chromium's files out of the settings folder

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let running: RunningApp | undefined;
let quitting = false;

async function quit() {
  if (quitting) return;
  quitting = true;
  tray?.destroy();
  // Never hang on the way out: give the server a few seconds to finish, then go.
  await Promise.race([running?.stop(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {});
  app.exit(0);
}

const windowOpen = () => Boolean(window && !window.isDestroyed());

function show(query = "") {
  if (!windowOpen()) return createWindow(query);
  if (query) void window!.loadURL(`${origin}/?${query}`);
  if (window!.isMinimized()) window!.restore();
  window!.show();
  window!.focus();
}

/** With the window gone: keep running from the tray while posts are waiting or Drive is watched, otherwise quit. */
function windowGone() {
  if (quitting) return;
  if (running?.keepAlive()) showTray();
  else void quit();
}

/** Same-origin pages stay in the window; everything else, including sign-ins, goes to the system browser. */
function openOutside(url: string) {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
}

function createWindow(query = "") {
  window = new BrowserWindow({
    title: "FreePoster",
    icon,
    width: 1280,
    height: 880,
    minWidth: 420,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#161615",
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  window.once("ready-to-show", () => window!.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });
  // Google and others refuse sign-in inside an embedded window, so Connect opens the system browser;
  // the server's callback then hands the result back here (see onSignIn below).
  window.webContents.on("will-navigate", (event, url) => {
    const target = new URL(url);
    if (target.origin === origin && !target.pathname.startsWith("/connect/")) return;
    event.preventDefault();
    openOutside(url);
  });
  window.on("close", (event) => {
    // Scheduled posts and the Drive folder need FreePoster running: hide to the tray (keeping the page as it was).
    if (quitting || !running?.keepAlive()) return;
    event.preventDefault();
    window!.hide();
    showTray();
  });
  window.on("closed", windowGone);
  void window.loadURL(query ? `${origin}/?${query}` : origin);
}

function showTray() {
  if (tray) return;
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("FreePoster: watching Google Drive and posting in the background");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open FreePoster", click: () => show() },
    { type: "separator" },
    { label: "Quit", click: () => void quit() },
  ]));
  tray.on("click", () => show());
  tray.displayBalloon?.({
    title: "FreePoster is still running",
    content: "Scheduled posts go out on time, and new videos in your Google Drive folder are picked up. Quit from this icon to stop.",
    iconType: "info",
  });
  let shownError: string | null = null;
  const exitWhenDone = setInterval(() => {
    // Drive needs the user (sign-in revoked, folder gone): say so once, from the tray.
    const error = running?.driveError() ?? null;
    if (error && error !== shownError) tray?.displayBalloon?.({ title: "FreePoster: Google Drive stopped", content: error, iconType: "warning" });
    shownError = error;
    if (windowOpen() && window!.isVisible()) return;
    if (!running?.keepAlive()) {
      clearInterval(exitWhenDone);
      void quit();
    }
  }, 60_000);
}

if (!app.requestSingleInstanceLock()) {
  // Already running (maybe in the tray): that copy brings its window forward.
  app.exit(0);
} else {
  app.on("second-instance", () => show());
  app.on("window-all-closed", () => {}); // handled by windowGone, so the tray can keep FreePoster alive

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try {
      running = await startApp({ onQuit: () => void quit(), onSignIn: (query) => show(query), showFolder: (path) => void shell.openPath(path) });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      dialog.showErrorBox("FreePoster", e.code === "EADDRINUSE"
        ? `Port ${config.port} is used by another program. Close it, or change PORT in ${join(config.root, ".env")}.`
        : `FreePoster could not start: ${e.message}`);
      return app.exit(1);
    }
    createWindow();
  });
}
