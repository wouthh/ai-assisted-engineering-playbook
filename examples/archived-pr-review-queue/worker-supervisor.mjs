#!/usr/bin/env node
/**
 * [AI_CONTEXT]
 * purpose: Supervise one local PR-review worker and terminate every process it creates.
 * touches: Linux child-subreaper ownership, Codex worker process groups, and timeout metadata.
 * invariants: cleanup never matches unrelated processes; detached descendants cannot outlive a completed worker.
 * inputs: a queue-created JSON config on argv[2] and the worker prompt on stdin.
 * outputs: the worker exit status plus optional termination metadata.
 * see: README.md
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const TERMINATION_GRACE_MS = 250;
const FINAL_REAP_DELAY_MS = 50;
const OWNER_POLL_INTERVAL_MS = 1000;
const SUBREAPER_ENV_NAME = "PR_REVIEW_FOLLOWUP_SUBREAPER";

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function readConfig(configPath) {
  if (process.platform !== "linux") {
    throw new Error("worker supervision requires Linux process metadata");
  }
  if (process.env[SUBREAPER_ENV_NAME] !== "1") {
    throw new Error(
      "worker supervisor must start inside its Linux child-subreaper boundary",
    );
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!config || typeof config !== "object") {
    throw new Error("worker supervisor config must be an object");
  }
  if (
    typeof config.command !== "string" ||
    config.command.trim().length === 0
  ) {
    throw new Error("worker supervisor command is required");
  }
  if (
    !Array.isArray(config.args) ||
    !config.args.every((value) => typeof value === "string")
  ) {
    throw new Error("worker supervisor args must be strings");
  }
  if (typeof config.cwd !== "string" || config.cwd.length === 0) {
    throw new Error("worker supervisor cwd is required");
  }
  if (
    typeof config.markerName !== "string" ||
    !/^[A-Z][A-Z0-9_]*$/u.test(config.markerName)
  ) {
    throw new Error("worker supervisor markerName is invalid");
  }
  if (
    typeof config.markerValue !== "string" ||
    config.markerValue.length === 0
  ) {
    throw new Error("worker supervisor markerValue is required");
  }
  if (typeof config.statusFile !== "string" || config.statusFile.length === 0) {
    throw new Error("worker supervisor statusFile is required");
  }
  if (
    config.removeEnv !== undefined &&
    (!Array.isArray(config.removeEnv) ||
      !config.removeEnv.every(
        (value) =>
          typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/u.test(value),
      ))
  ) {
    throw new Error("worker supervisor removeEnv is invalid");
  }
  const resolvedConfigDir = path.dirname(path.resolve(configPath));
  const resolvedCleanupDir = path.resolve(config.cleanupDir ?? "");
  if (
    resolvedCleanupDir !== resolvedConfigDir ||
    !path.basename(resolvedCleanupDir).startsWith("review-queue-exec-")
  ) {
    throw new Error(
      "worker supervisor cleanupDir must be its queue-created temp directory",
    );
  }
  return {
    ...config,
    cleanupDir: resolvedCleanupDir,
    timeoutMs: positiveInteger(config.timeoutMs, "worker supervisor timeoutMs"),
    ownerPid: positiveInteger(config.ownerPid, "worker supervisor ownerPid"),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processTable() {
  if (process.platform !== "linux") {
    return new Map();
  }
  const processes = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync("/proc", { withFileTypes: true });
  } catch {
    return processes;
  }
  for (const entry of entries) {
    try {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
        continue;
      }
      const pid = Number(entry.name);
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
        continue;
      }
      const stat = fs.readFileSync(`/proc/${entry.name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const parentPid = Number(fields[1]);
      const startTime = fields[19];
      if (
        Number.isSafeInteger(parentPid) &&
        parentPid >= 0 &&
        typeof startTime === "string" &&
        startTime.length > 0
      ) {
        processes.set(pid, {
          pid,
          parentPid,
          startTime,
        });
      }
    } catch {
      // A process can exit or become unreadable between listing and inspection.
    }
  }
  return processes;
}

function ownedProcessIdentities() {
  const processes = processTable();
  const childrenByParent = new Map();
  for (const identity of processes.values()) {
    const children = childrenByParent.get(identity.parentPid) ?? [];
    children.push(identity);
    childrenByParent.set(identity.parentPid, children);
  }
  const owned = [];
  const pendingParentPids = [process.pid];
  while (pendingParentPids.length > 0) {
    const parentPid = pendingParentPids.pop();
    for (const child of childrenByParent.get(parentPid) ?? []) {
      owned.push(child);
      pendingParentPids.push(child.pid);
    }
  }
  return owned;
}

function processIdentityMatches(identity) {
  try {
    const stat = fs.readFileSync(`/proc/${identity.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] === identity.startTime;
  } catch {
    return false;
  }
}

function signalProcess(identity, signal) {
  if (!processIdentityMatches(identity)) {
    return;
  }
  try {
    process.kill(identity.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

function signalProcessGroup(processGroupId, signal) {
  if (
    process.platform === "win32" ||
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 1
  ) {
    return;
  }
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

function signalOwnedProcesses(signal) {
  for (const identity of ownedProcessIdentities()) {
    signalProcess(identity, signal);
  }
}

async function terminateWorker(childPid, { includeProcessGroup = true } = {}) {
  let initialOwnedProcesses = ownedProcessIdentities();
  if (!includeProcessGroup && initialOwnedProcesses.length === 0) {
    await delay(FINAL_REAP_DELAY_MS);
    initialOwnedProcesses = ownedProcessIdentities();
  }
  if (!includeProcessGroup && initialOwnedProcesses.length === 0) {
    return;
  }
  if (includeProcessGroup) {
    signalProcessGroup(childPid, "SIGTERM");
  }
  for (const identity of initialOwnedProcesses) {
    signalProcess(identity, "SIGTERM");
  }
  await delay(TERMINATION_GRACE_MS);
  if (includeProcessGroup) {
    signalProcessGroup(childPid, "SIGKILL");
  }
  signalOwnedProcesses("SIGKILL");
  await delay(FINAL_REAP_DELAY_MS);
  signalOwnedProcesses("SIGKILL");
}

function writeTerminationStatus(config, value) {
  try {
    fs.writeFileSync(config.statusFile, `${JSON.stringify(value)}\n`);
  } catch {
    // The exit status remains authoritative if the temp directory disappeared.
  }
}

function ownerIsAlive(ownerPid) {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${ownerPid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      if (state === "Z") {
        return false;
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        return false;
      }
    }
  }
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function signalExitCode(signal) {
  return 128 + (os.constants.signals[signal] ?? 1);
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    throw new Error("worker supervisor config path is required");
  }
  const config = readConfig(configPath);
  const prompt = fs.readFileSync(0);
  const childEnv = { ...process.env };
  for (const name of config.removeEnv ?? []) {
    delete childEnv[name];
  }
  childEnv[config.markerName] = config.markerValue;
  const child = spawn(config.command, config.args, {
    cwd: config.cwd,
    detached: process.platform !== "win32",
    env: childEnv,
    stdio: ["pipe", "inherit", "inherit"],
  });

  let finishing = false;
  let timeoutHandle = null;
  let ownerHandle = null;

  const finish = async ({
    exitCode,
    reason,
    signal = null,
    includeProcessGroup = true,
  }) => {
    if (finishing) {
      return;
    }
    finishing = true;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (ownerHandle) {
      clearInterval(ownerHandle);
    }
    writeTerminationStatus(config, {
      reason,
      signal,
      exit_code: exitCode,
      worker_pid: child.pid ?? null,
    });
    await terminateWorker(child.pid, { includeProcessGroup });
    if (
      reason === "owner_exit" ||
      signal === "SIGTSTP" ||
      !ownerIsAlive(config.ownerPid)
    ) {
      fs.rmSync(config.cleanupDir, { recursive: true, force: true });
    }
    process.exit(exitCode);
  };

  for (const signal of ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM", "SIGTSTP"]) {
    process.once(signal, () => {
      void finish({
        exitCode: signalExitCode(signal),
        reason: "signal",
        signal,
      });
    });
  }

  timeoutHandle = setTimeout(() => {
    void finish({
      exitCode: 124,
      reason: "timeout",
    });
  }, config.timeoutMs);

  ownerHandle = setInterval(() => {
    if (!ownerIsAlive(config.ownerPid)) {
      void finish({
        exitCode: 143,
        reason: "owner_exit",
        signal: "SIGTERM",
      });
    }
  }, OWNER_POLL_INTERVAL_MS);

  child.once("error", (error) => {
    writeTerminationStatus(config, {
      reason: "spawn_error",
      message: error?.message ?? String(error),
      exit_code: 1,
      worker_pid: child.pid ?? null,
    });
    void finish({
      exitCode: 1,
      reason: "spawn_error",
    });
  });
  child.once("exit", (code, signal) => {
    if (finishing) {
      return;
    }
    const exitCode = Number.isInteger(code) ? code : signalExitCode(signal);
    void finish({
      exitCode,
      reason: "worker_exit",
      signal,
      includeProcessGroup: false,
    });
  });
  child.stdin.on("error", (error) => {
    if (error?.code !== "EPIPE") {
      void finish({
        exitCode: 1,
        reason: "stdin_error",
      });
    }
  });
  child.stdin.end(prompt);
}

main().catch((error) => {
  process.stderr.write(
    `pr-review-followup worker supervisor: ${error?.message ?? String(error)}\n`,
  );
  process.exit(1);
});
