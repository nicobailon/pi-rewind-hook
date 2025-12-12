import type { HookAPI } from "@mariozechner/pi-coding-agent/hooks";

const REF_PREFIX = "refs/pi-checkpoints/";
const MAX_CHECKPOINTS = 100;

export default function (pi: HookAPI) {
  const checkpoints = new Map<number, string>();
  let resumeCheckpoint: string | null = null;

  console.error(`[rewind] Hook loaded`);

  pi.on("session_start", async (event, ctx) => {
    if (!ctx.hasUI) return;

    const checkpointId = `checkpoint-resume-${Date.now()}`;

    try {
      await ctx.exec("git", [
        "update-ref",
        `${REF_PREFIX}${checkpointId}`,
        "HEAD",
      ]);

      resumeCheckpoint = checkpointId;
      console.error(`[rewind] Created resume checkpoint: ${checkpointId}`);
    } catch (err) {
      console.error(`[rewind] Failed to create resume checkpoint: ${err}`);
    }
  });

  pi.on("turn_start", async (event, ctx) => {
    if (!ctx.hasUI) return;

    const checkpointId = `checkpoint-${event.timestamp}`;

    try {
      await ctx.exec("git", [
        "update-ref",
        `${REF_PREFIX}${checkpointId}`,
        "HEAD",
      ]);

      checkpoints.set(event.turnIndex, checkpointId);
      console.error(
        `[rewind] Created checkpoint ${checkpointId} for turn ${event.turnIndex}`
      );

      await pruneCheckpoints(ctx);
    } catch (err) {
      console.error(`[rewind] Failed to create checkpoint: ${err}`);
    }
  });

  pi.on("branch", async (event, ctx) => {
    if (!ctx.hasUI) return;

    let checkpointId = checkpoints.get(event.targetTurnIndex);
    let usingResumeCheckpoint = false;

    if (!checkpointId && resumeCheckpoint) {
      checkpointId = resumeCheckpoint;
      usingResumeCheckpoint = true;
    }

    if (!checkpointId) {
      ctx.ui.notify(
        "No checkpoint available for this message",
        "info"
      );
      return undefined;
    }

    const options = usingResumeCheckpoint
      ? [
          "Restore to session start (files + conversation)",
          "Conversation only (keep current files)",
          "Restore to session start (files only, keep conversation)",
        ]
      : [
          "Restore all (files + conversation)",
          "Conversation only (keep current files)",
          "Code only (restore files, keep conversation)",
        ];

    const choice = await ctx.ui.select("Restore Options", options);

    if (!choice) {
      ctx.ui.notify("Rewind cancelled", "info");
      return { skipConversationRestore: true };
    }

    if (choice.startsWith("Conversation only")) {
      return undefined;
    }

    try {
      const ref = `${REF_PREFIX}${checkpointId}`;
      await ctx.exec("git", ["checkout", ref, "--", "."]);
      console.error(`[rewind] Restored files from ${checkpointId}`);
      ctx.ui.notify(
        usingResumeCheckpoint 
          ? "Files restored to session start" 
          : "Files restored from checkpoint",
        "success"
      );
    } catch (err) {
      console.error(`[rewind] Failed to restore: ${err}`);
      ctx.ui.notify(`Failed to restore files: ${err}`, "error");
      return { skipConversationRestore: true };
    }

    if (choice.includes("files only") || choice.startsWith("Code only")) {
      return { skipConversationRestore: true };
    }

    return undefined;
  });

  async function pruneCheckpoints(ctx: { exec: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }> }) {
    try {
      const result = await ctx.exec("git", [
        "for-each-ref",
        "--sort=creatordate",
        "--format=%(refname)",
        REF_PREFIX,
      ]);

      const refs = result.stdout.trim().split("\n").filter(Boolean);

      if (refs.length > MAX_CHECKPOINTS) {
        const toDelete = refs.slice(0, refs.length - MAX_CHECKPOINTS);
        for (const ref of toDelete) {
          await ctx.exec("git", ["update-ref", "-d", ref]);
          console.error(`[rewind] Pruned old checkpoint: ${ref}`);
        }
      }
    } catch (err) {
      console.error(`[rewind] Failed to prune checkpoints: ${err}`);
    }
  }
}
