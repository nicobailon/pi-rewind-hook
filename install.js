#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");

const REPO_URL = "https://raw.githubusercontent.com/nicobailon/pi-rewind-hook/main";
const EXT_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "rewind");
const OLD_HOOK_DIR = path.join(os.homedir(), ".pi", "agent", "hooks", "rewind");
const SETTINGS_FILE = path.join(os.homedir(), ".pi", "agent", "settings.json");

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return download(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download ${url}: ${res.statusCode}`));
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function main() {
  console.log("Installing pi-rewind-hook (Rewind Extension)...\n");

  fs.mkdirSync(EXT_DIR, { recursive: true });
  console.log(`Created directory: ${EXT_DIR}`);

  console.log("Downloading index.ts...");
  const extContent = await download(`${REPO_URL}/index.ts`);
  fs.writeFileSync(path.join(EXT_DIR, "index.ts"), extContent);

  console.log("Downloading package.json...");
  const pkgContent = await download(`${REPO_URL}/package.json`);
  fs.writeFileSync(path.join(EXT_DIR, "package.json"), pkgContent);

  console.log("Downloading README.md...");
  const readmeContent = await download(`${REPO_URL}/README.md`);
  fs.writeFileSync(path.join(EXT_DIR, "README.md"), readmeContent);

  // Migrate old hooks to extensions and clean up legacy settings
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      let settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
      let modified = false;

      // Remove old hooks key
      if (settings.hooks && Array.isArray(settings.hooks)) {
        delete settings.hooks;
        console.log("\nRemoved old 'hooks' key from settings");
        modified = true;
      }

      // Remove rewind from explicit extensions (auto-discovery handles it now)
      if (Array.isArray(settings.extensions)) {
        const before = settings.extensions.length;
        settings.extensions = settings.extensions.filter(p => 
          !p.includes("/extensions/rewind")
        );
        if (settings.extensions.length < before) {
          console.log("Removed rewind from explicit extensions (auto-discovery handles it)");
          modified = true;
        }
        // Clean up empty extensions array
        if (settings.extensions.length === 0) {
          delete settings.extensions;
          modified = true;
        }
      }

      if (modified) {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
      }
    } catch (err) {
      console.error(`Warning: Could not update settings.json: ${err.message}`);
    }
  }

  // Clean up old hooks directory
  if (fs.existsSync(OLD_HOOK_DIR)) {
    console.log(`\nCleaning up old hooks directory: ${OLD_HOOK_DIR}`);
    fs.rmSync(OLD_HOOK_DIR, { recursive: true, force: true });
    console.log("Removed old hooks/rewind directory");
  }

  console.log("\nInstallation complete!");
  console.log("\nThe extension is auto-discovered from ~/.pi/agent/extensions/rewind/");
  console.log("Restart pi to load the extension. Use /branch to rewind to a checkpoint.");
}

main().catch((err) => {
  console.error(`\nInstallation failed: ${err.message}`);
  process.exit(1);
});
