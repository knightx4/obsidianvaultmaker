import { execSync } from "child_process";
import os from "os";

const DEFAULT_PROMPT = "Choose vault folder";

/**
 * Open the system folder picker and return the selected path, or null if cancelled.
 * Works when the server runs locally (e.g. npm run dev on your machine).
 * @param prompt - Dialog title/prompt (e.g. "Choose vault folder" or "Choose folder to import from")
 */
export function pickFolder(prompt: string = DEFAULT_PROMPT): { path: string } | { cancelled: true } | { error: string } {
  const platform = os.platform();
  const escaped = prompt.replace(/'/g, "'\\\\''");
  try {
    if (platform === "darwin") {
      const result = execSync(
        `osascript -e 'return POSIX path of (choose folder with prompt "${escaped}")'`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
      const path = (result || "").trim();
      if (!path) return { cancelled: true };
      return { path };
    }
    if (platform === "win32") {
      const winPrompt = prompt.replace(/'/g, "''");
      const result = execSync(
        `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = '${winPrompt}'; if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }"`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
      const path = (result || "").trim();
      if (!path) return { cancelled: true };
      return { path };
    }
    if (platform === "linux") {
      const linuxTitle = prompt.replace(/"/g, '\\"');
      try {
        const result = execSync(`zenity --file-selection --directory --title="${linuxTitle}"`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        const path = (result || "").trim();
        if (!path) return { cancelled: true };
        return { path };
      } catch {
        const result = execSync(`kdialog --getexistingdirectory . --title "${linuxTitle}"`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        const path = (result || "").trim();
        if (!path) return { cancelled: true };
        return { path };
      }
    }
    return { error: "Folder picker not supported on this platform" };
  } catch (err: unknown) {
    const code = err && typeof err === "object" && "status" in err ? (err as { status: number }).status : null;
    if (code === 1 || code === 256) return { cancelled: true };
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}
