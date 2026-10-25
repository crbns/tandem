import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Live view retention: agent_activity rows older than 14 days.
crons.cron("prune agent activity", "17 9 * * *", internal.activity.pruneActivity, {});

export default crons;
