import { zipSync, strToU8 } from "fflate";
import archiver from "archiver";
import { PassThrough } from "stream";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { type Message, AttachmentBuilder } from "discord.js";
import { isGuildOwner, isBotOwner, isCoOwner, COLORS } from "./permissions.js";
import { makeEmbed } from "./logging.js";
import { DIRS, backupGuildData } from "./persistence.js";
import { logger } from "./logger.js";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const BOT_ROOT = path.resolve(SRC_DIR, "..");

async function readFileOrEmpty(filePath: string): Promise<Uint8Array> {
  try {
    return strToU8(await fs.readFile(filePath, "utf8"));
  } catch {
    return strToU8(JSON.stringify([], null, 2));
  }
}

async function readFileOrNull(filePath: string): Promise<Uint8Array | null> {
  try {
    return strToU8(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function createZipBuffer(guildId: string, guildName: string): Promise<Buffer> {
  const guildDataPath = path.join(DIRS.guilds, guildId);
  const brainDataPath = path.join(DIRS.brain, guildId);

  // ── Source files: auto-scan src/ so every new .ts file is included automatically ──
  const srcEntries = await fs.readdir(SRC_DIR);
  const tsFiles = srcEntries.filter((f) => f.endsWith(".ts"));
  const srcResults = await Promise.all(
    tsFiles.map((f) => readFileOrNull(path.join(SRC_DIR, f)))
  );

  // ── Root config files ──
  const [pkgJson, tsConfig] = await Promise.all([
    readFileOrNull(path.join(BOT_ROOT, "package.json")),
    readFileOrNull(path.join(BOT_ROOT, "tsconfig.json")),
  ]);

  // ── Guild data files ──
  const dataFiles = ["warns.json", "mutes.json", "flags.json", "whitelist.json", "scripts.json", "blacklist.json", "economy.json"];
  const brainFiles = ["phrases.json", "patterns.json", "messages.json", "stats.json", "profiles.json"];

  const [dataResults, brainResults] = await Promise.all([
    Promise.all(dataFiles.map((f) => readFileOrEmpty(path.join(guildDataPath, f)))),
    Promise.all(brainFiles.map((f) => readFileOrEmpty(path.join(brainDataPath, f)))),
  ]);

  // ── Config files (mood, etc.) ──
  const configEntries = await fs.readdir(DIRS.configs).catch(() => [] as string[]);
  const configFiles = configEntries.filter((f) => f.endsWith(".json"));
  const configResults = await Promise.all(
    configFiles.map((f) => readFileOrNull(path.join(DIRS.configs, f)))
  );

  const manifest = {
    exportedAt: new Date().toISOString(),
    guildId,
    guildName,
    sourceFiles: tsFiles,
    contents: {
      "src/":     "All bot source code (.ts files — auto-collected)",
      "data/":    "Moderation data: warns, mutes, flags, whitelist, scripts, blacklist, economy",
      "memory/":  "AI brain memory: phrases, patterns, messages, stats, profiles",
      "configs/": "Bot config files: mood, etc.",
    },
    restoreInstructions: [
      "1. Copy 'src/' into the bot's src/ directory",
      "2. Copy 'data/' and 'memory/' into the bot's working directory",
      "3. Set up PostgreSQL and run: pnpm --filter @workspace/db run push",
      "4. Start the bot — it auto-imports from files when the database is empty",
    ],
  };

  const zipInput: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
  };

  // Source files
  for (let i = 0; i < tsFiles.length; i++) {
    if (srcResults[i]) zipInput[`src/${tsFiles[i]}`] = srcResults[i]!;
  }

  // Root configs
  if (pkgJson)   zipInput["package.json"]  = pkgJson;
  if (tsConfig)  zipInput["tsconfig.json"] = tsConfig;

  // Guild data
  for (let i = 0; i < dataFiles.length; i++) {
    zipInput[`data/${dataFiles[i]}`] = dataResults[i]!;
  }
  for (let i = 0; i < brainFiles.length; i++) {
    zipInput[`memory/${brainFiles[i]}`] = brainResults[i]!;
  }

  // Config files
  for (let i = 0; i < configFiles.length; i++) {
    if (configResults[i]) zipInput[`configs/${configFiles[i]}`] = configResults[i]!;
  }

  const zipped = zipSync(zipInput, { level: 6 });
  return Buffer.from(zipped);
}

export async function handleExport(message: Message): Promise<void> {
  if (!message.guild || !message.member) return;

  // Permission check — server channel reply is fine here
  if (!isGuildOwner(message.member)) {
    await message.reply({
      embeds: [makeEmbed({
        title: "❌ No Permission",
        color: COLORS.error,
        description: "Only the **server owner** can export guild data.",
      })],
    });
    return;
  }

  const guildId = message.guild.id;
  const guildName = message.guild.name;

  // Acknowledge in-server so the owner knows it's working
  const statusMsg = await message.reply({
    embeds: [makeEmbed({
      title: "⏳ Creating Export...",
      color: COLORS.info,
      description: "Backing up all data and building the zip — I'll DM it to you when ready.",
    })],
  });

  try {
    // Write latest DB state to disk first (non-fatal if it fails)
    try {
      await backupGuildData(guildId);
    } catch (backupErr) {
      logger.warn({ backupErr }, "Pre-export backup failed — using existing files");
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = guildName.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);
    const zipName = `export-${safeName}-${ts}.zip`;

    const buffer = await createZipBuffer(guildId, guildName);

    const LIMIT_BYTES = 8 * 1024 * 1024;
    if (buffer.length > LIMIT_BYTES) {
      await statusMsg.edit({
        embeds: [makeEmbed({
          title: "❌ Export Too Large",
          color: COLORS.error,
          description: `Export is **${(buffer.length / 1024 / 1024).toFixed(1)} MB** — exceeds Discord's 8 MB limit. Your data is safely saved on the server.`,
        })],
      });
      return;
    }

    // Try to open a DM channel with the server owner
    let dmFailed = false;
    try {
      const dmChannel = await message.author.createDM();
      const attachment = new AttachmentBuilder(buffer, { name: zipName });

      await dmChannel.send({
        embeds: [makeEmbed({
          title: "📦 Export Complete",
          color: COLORS.success,
          description: `All data for **${guildName}** exported successfully.`,
          fields: [
            { name: "📁 File", value: `\`${zipName}\``, inline: true },
            { name: "💾 Size", value: `${(buffer.length / 1024).toFixed(1)} KB`, inline: true },
            { name: "📋 Contents", value: "Warns · Mutes · Flags · Whitelist · Scripts · Blacklist · Brain Phrases · Patterns · Messages · Stats · Profiles" },
            { name: "♻️ Restore", value: "See `manifest.json` inside the zip for restore instructions." },
            { name: "⚠️ Security", value: "This file contains all server moderation history — keep it safe." },
          ],
        })],
        files: [attachment],
      });

      logger.info({ guildId, guildName, sizeBytes: buffer.length }, "Export sent via DM");
    } catch (dmErr) {
      logger.warn({ dmErr }, "Could not DM export — user likely has DMs disabled");
      dmFailed = true;
    }

    // Update the in-server status message
    if (dmFailed) {
      await statusMsg.edit({
        embeds: [makeEmbed({
          title: "❌ DMs Closed",
          color: COLORS.error,
          description: "Couldn't send the export to your DMs.\n\nPlease **enable DMs from server members** in your Privacy Settings, then try again.",
        })],
      });
    } else {
      await statusMsg.edit({
        embeds: [makeEmbed({
          title: "✅ Export Sent",
          color: COLORS.success,
          description: `Check your DMs — the export zip for **${guildName}** has been sent privately.`,
        })],
      });
    }
  } catch (err) {
    logger.error({ err }, "Export failed");
    const errMsg = err instanceof Error ? err.message : String(err);
    try {
      await statusMsg.edit({
        embeds: [makeEmbed({
          title: "❌ Export Failed",
          color: COLORS.error,
          description: `Something went wrong while creating the export.\n\`\`\`${errMsg}\`\`\``,
        })],
      });
    } catch {
      await message.reply({
        embeds: [makeEmbed({
          title: "❌ Export Failed",
          color: COLORS.error,
          description: "Something went wrong while creating the export. Please try again.",
        })],
      }).catch(() => {});
    }
  }
}

// ─── ?backupbot — full recursive bot backup, owner/co-owner only ────────────

const BACKUP_EXCLUDE_DIRS  = new Set(["node_modules", "dist", ".git", ".cache"]);
const BACKUP_EXCLUDE_FILES = new Set([".env", ".env.local", ".env.production"]);
const BACKUP_MAX_FILE_BYTES = 512 * 1024; // skip any single file > 512 KB

function makeRestoreReadme(): string {
  return `=== SANTO BOT — RESTORE INSTRUCTIONS ===

HOW TO RESTORE THIS BOT IN A NEW REPLIT PROJECT
================================================

1. CREATE A NEW REPLIT
   - Go to replit.com and create a new project (Node.js)
   - Upload the contents of this ZIP into the project root

2. INSTALL DEPENDENCIES
   Run in the Replit shell:
     npm install
   or if using pnpm:
     pnpm install

3. ADD YOUR SECRETS (Replit Secrets tab)
   Required:
     TOKEN              = your Discord bot token
     OWNER_ID           = your Discord user ID

   AI providers (add at least one):
     OPENROUTER_API_KEY = your OpenRouter key (primary AI)
     GROQ_API_KEY       = your Groq key (fallback AI)
     GROQ_API_KEY_1     = additional Groq key (optional)
     GROQ_API_KEY_2     = additional Groq key (optional)
     GROQ_API_KEY_3     = additional Groq key (optional)
     GROQ_API_KEY_4     = additional Groq key (optional)
     GROQ_API_KEY_5     = additional Groq key (optional)
     DEEPSEEK_API_KEY   = DeepSeek key (tertiary AI, optional)

   Database (if using PostgreSQL features):
     DATABASE_URL       = your PostgreSQL connection string

4. START THE BOT
   Run in the shell:
     npx tsx src/index.ts
   or if using the workflow system:
     The workflow is already configured — just press Run.

5. IF HANDING TO AN AI AGENT (e.g. Replit AI)
   Tell it:
   "This is a Discord bot called santo. It uses discord.js v14,
    TypeScript, and has: AI chat replies (OpenRouter + Groq fallback),
    moderation commands, economy system, word game, brain/memory learning,
    anti-nuke, tickets, and a multi-key AI rotation system.
    The main entry point is src/index.ts."

=== CONTENTS OF THIS BACKUP ===
  src/       All TypeScript source files (auto-scanned)
  data/      Moderation data (warns, mutes, flags, etc.)
  memory/    AI brain memory (phrases, patterns, messages)
  configs/   Bot config files
  package.json, tsconfig.json, build.mjs

=== SECURITY NOTE ===
  This backup does NOT contain any API keys or secrets.
  You must re-add all secrets manually (see Step 3 above).
`;
}

async function collectFilesRecursively(
  dir: string,
  baseDir: string
): Promise<Record<string, Uint8Array>> {
  const result: Record<string, Uint8Array> = {};

  async function scan(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        if (BACKUP_EXCLUDE_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;
        await scan(fullPath);
      } else if (entry.isFile()) {
        if (BACKUP_EXCLUDE_FILES.has(entry.name)) continue;
        if (entry.name.startsWith(".env")) continue; // never include .env*
        // Skip log/temp/build outputs
        if (entry.name.endsWith(".log")) continue;
        if (entry.name.endsWith(".map")) continue;
        if (entry.name.endsWith(".mjs") && relPath.startsWith("dist/")) continue;

        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > BACKUP_MAX_FILE_BYTES) continue;
          const content = await fs.readFile(fullPath);
          result[relPath] = new Uint8Array(content);
        } catch {
          // unreadable — skip silently
        }
      }
    }
  }

  await scan(dir);
  return result;
}

async function createFullBackupBuffer(guildId: string): Promise<Buffer> {
  // Flush latest guild state to disk before packing
  try { await backupGuildData(guildId); } catch { /* non-fatal */ }

  // Directories to include in the backup
  const includeDirs = [
    path.join(BOT_ROOT, "src"),
    path.join(BOT_ROOT, "data"),
    path.join(BOT_ROOT, "memory"),
    path.join(BOT_ROOT, "configs"),
  ];

  const zipInput: Record<string, Uint8Array> = {};

  // Recursive scan each directory
  for (const dir of includeDirs) {
    try {
      const files = await collectFilesRecursively(dir, BOT_ROOT);
      Object.assign(zipInput, files);
    } catch {
      // directory may not exist — skip
    }
  }

  // Root config files
  for (const name of ["package.json", "tsconfig.json", "build.mjs"]) {
    try {
      const content = await fs.readFile(path.join(BOT_ROOT, name));
      zipInput[name] = new Uint8Array(content);
    } catch { /* missing — skip */ }
  }

  // Always include the restore README
  zipInput["README_RESTORE.txt"] = strToU8(makeRestoreReadme());

  const zipped = zipSync(zipInput, { level: 6 });
  return Buffer.from(zipped);
}

export async function handleBackupBot(message: Message): Promise<void> {
  if (!message.guild || !message.member) return;

  // Permission: "- owner", "- co owner", OWNER_ID, or Discord guild owner
  if (!isCoOwner(message.member)) {
    await message.reply({
      embeds: [makeEmbed({
        title: "❌ No Permission",
        color: COLORS.error,
        description: "Only users with the **- owner** or **- co owner** role can use `?backupbot`.",
      })],
    });
    return;
  }

  let statusMsg;
  try {
    statusMsg = await message.reply({
      embeds: [makeEmbed({
        title: "⏳ Building Full Backup...",
        color: COLORS.info,
        description: "Scanning all files and compressing — this takes a few seconds. I'll DM it to you.",
      })],
    });
  } catch { return; }

  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const zipName = `backup-${ts}.zip`;
    const buffer = await createFullBackupBuffer(message.guild.id);

    const LIMIT = 8 * 1024 * 1024;
    if (buffer.length > LIMIT) {
      await statusMsg.edit({
        embeds: [makeEmbed({
          title: "❌ Backup Too Large",
          color: COLORS.error,
          description: `Backup is **${(buffer.length / 1024 / 1024).toFixed(1)} MB** — exceeds Discord's 8 MB limit. Your data is safely saved on the server.`,
        })],
      });
      return;
    }

    const fileSizeKB = (buffer.length / 1024).toFixed(1);

    try {
      const dm = await message.author.createDM();
      await dm.send({
        embeds: [makeEmbed({
          title: "📦 Full Bot Backup",
          color: COLORS.success,
          description: "Complete backup of your bot — source code, data, brain memory, and configs.",
          fields: [
            { name: "📁 File",     value: `\`${zipName}\``,      inline: true },
            { name: "💾 Size",     value: `${fileSizeKB} KB`,    inline: true },
            { name: "📋 Contents", value: "`src/` · `data/` · `memory/` · `configs/` · `package.json` · `README_RESTORE.txt`" },
            { name: "♻️ Restore",  value: "See `README_RESTORE.txt` inside the zip for full restore + AI handoff instructions." },
            { name: "🔒 Security", value: "No API keys or tokens are included — re-add secrets manually when restoring." },
          ],
        })],
        files: [new AttachmentBuilder(buffer, { name: zipName })],
      });
      await statusMsg.edit({
        embeds: [makeEmbed({
          title: "✅ Backup Sent",
          color: COLORS.success,
          description: `Full backup sent to your DMs (\`${fileSizeKB} KB\`). Keep it safe.`,
        })],
      });
      logger.info({ guildId: message.guild.id, sizeBytes: buffer.length }, "?backupbot sent via DM");
    } catch {
      await statusMsg.edit({
        embeds: [makeEmbed({
          title: "❌ DMs Closed",
          color: COLORS.error,
          description: "Couldn't send to your DMs. Enable **DMs from server members** in Privacy Settings, then try again.",
        })],
      });
    }
  } catch (err) {
    logger.error({ err }, "?backupbot failed");
    await statusMsg.edit({
      embeds: [makeEmbed({
        title: "❌ Backup Failed",
        color: COLORS.error,
        description: "Something went wrong while creating the backup. Check the logs.",
      })],
    }).catch(() => {});
  }
}

// ?backup — bot owner only, always DMs the zip privately
export async function handleBackup(message: Message): Promise<void> {
  if (!message.guild || !message.member) return;

  if (!isBotOwner(message.author.id)) {
    await message.reply({
      embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only the **bot owner** can use `?backup`." })],
    });
    return;
  }

  const guildId = message.guild.id;
  const guildName = message.guild.name;

  let statusMsg;
  try {
    statusMsg = await message.reply({
      embeds: [makeEmbed({ title: "⏳ Creating Backup...", color: COLORS.info, description: "Building the zip — I'll DM it to you shortly." })],
    });
  } catch {
    return;
  }

  try {
    try { await backupGuildData(guildId); } catch { /* non-fatal */ }

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = guildName.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);
    const zipName = `backup-${safeName}-${ts}.zip`;
    const buffer = await createZipBuffer(guildId, guildName);

    const LIMIT = 8 * 1024 * 1024;
    if (buffer.length > LIMIT) {
      await statusMsg.edit({ embeds: [makeEmbed({ title: "❌ Backup Too Large", color: COLORS.error, description: `Backup is **${(buffer.length / 1024 / 1024).toFixed(1)} MB** — exceeds Discord's 8 MB limit.` })] });
      return;
    }

    try {
      const dm = await message.author.createDM();
      await dm.send({
        embeds: [makeEmbed({
          title: "📦 Backup Complete",
          color: COLORS.success,
          description: `Backup for **${guildName}** is ready.`,
          fields: [
            { name: "File", value: `\`${zipName}\``, inline: true },
            { name: "Size", value: `${(buffer.length / 1024).toFixed(1)} KB`, inline: true },
          ],
        })],
        files: [new AttachmentBuilder(buffer, { name: zipName })],
      });
      await statusMsg.edit({ embeds: [makeEmbed({ title: "✅ Backup Sent", color: COLORS.success, description: "Check your DMs." })] });
      logger.info({ guildId, sizeBytes: buffer.length }, "Backup sent via DM");
    } catch {
      await statusMsg.edit({ embeds: [makeEmbed({ title: "❌ DMs Closed", color: COLORS.error, description: "Enable DMs from server members, then try again." })] });
    }
  } catch (err) {
    logger.error({ err }, "Backup failed");
    await statusMsg.edit({ embeds: [makeEmbed({ title: "❌ Backup Failed", color: COLORS.error, description: "Something went wrong. Try again." })] }).catch(() => {});
  }
}
