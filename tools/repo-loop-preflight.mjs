#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_COOLDOWN_MINUTES = 10;
const DEFAULT_STATE_PATH = path.resolve(".codexhost/loop/state.json");

const SKIP_LABELS = new Set(["暂缓", "on-hold", "automation:ignore"]);
const MAINTAINER_LOGINS = new Set(["iruriQ", "BytePioneer-AI"]);

const UI_PATH_PATTERNS = [
  /^apps\/web-ui\//,
  /^apps\/desktop-shell\//,
  /^packages\/renderer-extension\//,
  /^packages\/console-server\/.*(ui|public|client|html|css)/i,
];

const HIGH_RISK_PATH_PATTERNS = [
  /^\.github\//,
  /^scripts\/release\//,
  /^crates\//,
  /^packages\/protocol-core\//,
  /^packages\/shared-contracts\//,
  /^package\.json$/,
  /^Cargo\.(toml|lock)$/,
];

const DOC_OR_TEST_PATTERNS = [
  /^docs\//,
  /^tests\//,
  /\/test\//,
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
  /\.md$/,
];

function parseArgs(argv) {
  const args = {
    cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
    statePath: DEFAULT_STATE_PATH,
    exitCode: false,
    includeIssues: true,
    markPr: null,
    markIssue: null,
    sha: null,
    updatedAt: null,
    status: null,
    note: "",
    roundInc: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--exit-code") {
      args.exitCode = true;
    } else if (token === "--no-issues") {
      args.includeIssues = false;
    } else if (token === "--round-inc") {
      args.roundInc = true;
    } else if (token === "--cooldown-minutes") {
      args.cooldownMinutes = Number(argv[++i]);
    } else if (token === "--state-path") {
      args.statePath = path.resolve(argv[++i]);
    } else if (token === "--mark-pr") {
      args.markPr = String(argv[++i]);
    } else if (token === "--mark-issue") {
      args.markIssue = String(argv[++i]);
    } else if (token === "--sha") {
      args.sha = argv[++i];
    } else if (token === "--updated-at") {
      args.updatedAt = argv[++i];
    } else if (token === "--status") {
      args.status = argv[++i];
    } else if (token === "--note") {
      args.note = argv[++i] ?? "";
    } else if (token === "--help" || token === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

function printUsage() {
  console.log(`Usage:
  node tools/repo-loop-preflight.mjs [--cooldown-minutes 10] [--no-issues] [--exit-code]
  node tools/repo-loop-preflight.mjs --mark-pr <num> --sha <oid> --status <status> [--round-inc] [--note <text>]
  node tools/repo-loop-preflight.mjs --mark-issue <num> --updated-at <iso> --status <status> [--note <text>]`);
}

function loadState(statePath) {
  if (!fs.existsSync(statePath)) {
    return { version: 1, prs: {}, issues: {} };
  }
  const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
  return {
    version: 1,
    prs: parsed.prs ?? {},
    issues: parsed.issues ?? {},
  };
}

function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function appendDailyLog(logDir, line) {
  fs.mkdirSync(logDir, { recursive: true });
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19);
  const logPath = path.join(logDir, `daily-${dateStr}.md`);
  fs.appendFileSync(logPath, `- [${timeStr}Z] ${line}\n`, "utf8");
}

function runGhJson(ghArgs) {
  const stdout = execFileSync("gh", ghArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout || "[]");
}

function classifyPr(pr, previousEntry, nowMs, cooldownMinutes) {
  const labels = (pr.labels ?? []).map((l) => l.name);
  const skipLabel = labels.find((name) => SKIP_LABELS.has(name));
  if (pr.isDraft) {
    return { actionable: false, reason: "draft" };
  }
  if (skipLabel) {
    return { actionable: false, reason: `label:${skipLabel}` };
  }

  const headSha = pr.headRefOid;
  if (previousEntry?.reviewedSha === headSha) {
    return {
      actionable: false,
      reason: `unchanged:${previousEntry.status ?? "reviewed"}`,
    };
  }

  const detail = runGhJson([
    "pr",
    "view",
    String(pr.number),
    "--json",
    "files,commits,reviews,comments",
  ]);
  const commits = Array.isArray(detail.commits) ? detail.commits : [];
  const latestCommit = commits.length > 0 ? commits[commits.length - 1] : null;
  const lastActivityIso = latestCommit?.committedDate ?? pr.updatedAt;
  const lastActivityMs = Date.parse(lastActivityIso);

  if (labels.includes("awaiting-author")) {
    const authorLogin = pr.author?.login ?? "";
    const feedbackTimestamps = [
      ...(Array.isArray(detail.reviews) ? detail.reviews : []).map((r) => r.submittedAt),
      ...(Array.isArray(detail.comments) ? detail.comments : [])
        .filter((c) => (c.author?.login ?? "") !== authorLogin)
        .map((c) => c.createdAt),
    ];
    const latestFeedbackMs = feedbackTimestamps.reduce((max, iso) => {
      const ts = Date.parse(iso ?? "");
      return Number.isFinite(ts) && ts > max ? ts : max;
    }, 0);
    if (latestFeedbackMs > 0 && lastActivityMs <= latestFeedbackMs) {
      return {
        actionable: false,
        reason: "awaiting-author:no-new-commits",
      };
    }
  }

  const minutesSinceActivity = Math.max(0, Math.floor((nowMs - lastActivityMs) / 60_000));

  if (minutesSinceActivity < cooldownMinutes) {
    return {
      actionable: false,
      reason: `cooldown:${minutesSinceActivity}m<${cooldownMinutes}m`,
    };
  }

  const files = (detail.files ?? []).map((f) => f.path);
  const prodFiles = files.filter((p) => !DOC_OR_TEST_PATTERNS.some((re) => re.test(p)));
  const hasUi = files.some((p) => UI_PATH_PATTERNS.some((re) => re.test(p)));
  const highRiskPaths = files.filter((p) => HIGH_RISK_PATH_PATTERNS.some((re) => re.test(p)));

  const authorLogin = pr.author?.login ?? "unknown";
  const isMaintainer = MAINTAINER_LOGINS.has(authorLogin);
  const totalChanges = (pr.additions ?? 0) + (pr.deletions ?? 0);

  let tier = "L1";
  if (highRiskPaths.length > 0 || !isMaintainer || prodFiles.length > 10) {
    tier = "L3";
  } else if (hasUi || totalChanges > 150 || prodFiles.length > 5) {
    tier = "L2";
  }

  const isIncremental = Boolean(
    previousEntry?.reviewedSha && previousEntry.reviewedSha !== headSha,
  );
  const rounds = previousEntry?.rounds ?? 0;

  return {
    actionable: true,
    item: {
      number: pr.number,
      title: pr.title,
      author: authorLogin,
      isMaintainer,
      headRefName: pr.headRefName,
      headSha,
      previousSha: previousEntry?.reviewedSha ?? null,
      isIncremental,
      diffRange: isIncremental ? `${previousEntry.reviewedSha}..${headSha}` : null,
      rounds,
      circuitBreakerHit: rounds >= 2,
      tier,
      hasUi,
      highRiskPaths,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      changedFiles: pr.changedFiles ?? files.length,
      prodFileCount: prodFiles.length,
      minutesSinceActivity,
      labels,
    },
  };
}

function handleMarkPr(args) {
  if (!args.sha || !args.status) {
    throw new Error("--mark-pr requires --sha and --status");
  }
  const state = loadState(args.statePath);
  const existing = state.prs[args.markPr] ?? {};
  const nextRounds = (existing.rounds ?? 0) + (args.roundInc ? 1 : 0);
  state.prs[args.markPr] = {
    reviewedSha: args.sha,
    status: args.status,
    rounds: nextRounds,
    lastCheckedAt: new Date().toISOString(),
    note: args.note,
  };
  saveState(args.statePath, state);
  appendDailyLog(
    path.dirname(args.statePath),
    `PR #${args.markPr} (${args.sha.slice(0, 7)}) -> ${args.status}${args.note ? `: ${args.note}` : ""}`,
  );
  console.log(
    JSON.stringify({ ok: true, pr: args.markPr, state: state.prs[args.markPr] }, null, 2),
  );
}

function handleMarkIssue(args) {
  if (!args.updatedAt || !args.status) {
    throw new Error("--mark-issue requires --updated-at and --status");
  }
  const state = loadState(args.statePath);
  state.issues[args.markIssue] = {
    updatedAt: args.updatedAt,
    status: args.status,
    lastCheckedAt: new Date().toISOString(),
    note: args.note,
  };
  saveState(args.statePath, state);
  appendDailyLog(
    path.dirname(args.statePath),
    `Issue #${args.markIssue} -> ${args.status}${args.note ? `: ${args.note}` : ""}`,
  );
  console.log(
    JSON.stringify(
      { ok: true, issue: args.markIssue, state: state.issues[args.markIssue] },
      null,
      2,
    ),
  );
}

function runPreflight(args) {
  const state = loadState(args.statePath);
  const nowMs = Date.now();

  const openPrs = runGhJson([
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "50",
    "--json",
    "number,title,author,isDraft,labels,updatedAt,headRefName,headRefOid,additions,deletions,changedFiles",
  ]);

  const actionablePrs = [];
  const skippedPrs = [];

  for (const pr of openPrs) {
    const previousEntry = state.prs[String(pr.number)];
    const result = classifyPr(pr, previousEntry, nowMs, args.cooldownMinutes);
    if (result.actionable) {
      actionablePrs.push(result.item);
    } else {
      skippedPrs.push({
        number: pr.number,
        title: pr.title,
        reason: result.reason,
      });
    }
  }

  // Prioritize incremental re-reviews and smaller L1 PRs first
  const tierRank = { L1: 1, L2: 2, L3: 3 };
  actionablePrs.sort((a, b) => {
    if (a.isIncremental !== b.isIncremental) return a.isIncremental ? -1 : 1;
    return (tierRank[a.tier] ?? 9) - (tierRank[b.tier] ?? 9);
  });

  const actionableIssues = [];
  if (args.includeIssues) {
    const openIssues = runGhJson([
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      "30",
      "--json",
      "number,title,author,labels,updatedAt,createdAt",
    ]);

    for (const issue of openIssues) {
      const labels = (issue.labels ?? []).map((l) => l.name);
      if (labels.some((name) => SKIP_LABELS.has(name))) continue;
      const previous = state.issues[String(issue.number)];
      if (previous?.updatedAt === issue.updatedAt) continue;
      actionableIssues.push({
        number: issue.number,
        title: issue.title,
        author: issue.author?.login ?? "unknown",
        updatedAt: issue.updatedAt,
        labels,
        previousStatus: previous?.status ?? null,
      });
    }
  }

  const hasWork = actionablePrs.length > 0 || actionableIssues.length > 0;
  const output = {
    checkedAt: new Date(nowMs).toISOString(),
    cooldownMinutes: args.cooldownMinutes,
    hasWork,
    summary: {
      actionablePrCount: actionablePrs.length,
      skippedPrCount: skippedPrs.length,
      actionableIssueCount: actionableIssues.length,
    },
    actionablePrs,
    skippedPrs,
    actionableIssues,
  };

  console.log(JSON.stringify(output, null, 2));

  if (args.exitCode && !hasWork) {
    process.exit(2);
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.markPr) {
    handleMarkPr(args);
  } else if (args.markIssue) {
    handleMarkIssue(args);
  } else {
    runPreflight(args);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
