import * as fs from "node:fs";
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import type { RequestError } from "@octokit/request-error";
import type { Attributes } from "@opentelemetry/api";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { ATTR_SERVICE_INSTANCE_ID, ATTR_SERVICE_NAMESPACE } from "@opentelemetry/semantic-conventions/incubating";
import axios, { isAxiosError } from "axios";
import { getJobsAnnotations, getPRsLabels, getWorkflowRun, listJobsForWorkflowRun } from "./github";
import { traceWorkflowRun } from "./trace/workflow";
import { createTracerProvider, stringToRecord } from "./tracer";

async function validateSubscription() {
  const eventPath = process.env["GITHUB_EVENT_PATH"];
  let repoPrivate: boolean | undefined;

  if (eventPath && fs.existsSync(eventPath)) {
    const eventData = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    repoPrivate = eventData?.repository?.private;
  }

  const upstream = "corentinmusard/otel-cicd-action";
  const action = process.env["GITHUB_ACTION_REPOSITORY"];
  const docsUrl = "https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions";

  core.info("");
  core.info("\u001b[1;36mStepSecurity Maintained Action\u001b[0m");
  core.info(`Secure drop-in replacement for ${upstream}`);
  if (repoPrivate === false) {
    core.info("\u001b[32m✓ Free for public repositories\u001b[0m");
  }
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`);
  core.info("");

  if (repoPrivate === false) {
    return;
  }

  const serverUrl = process.env["GITHUB_SERVER_URL"] || "https://github.com";
  const body: Record<string, string> = { action: action || "" };
  if (serverUrl !== "https://github.com") {
    body["ghes_server"] = serverUrl;
  }
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env["GITHUB_REPOSITORY"]}/actions/maintained-actions-subscription`,
      body,
      { timeout: 3000 }
    );
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 403) {
      core.error("\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m");
      core.error(`\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`);
      process.exit(1);
    }
    core.info("Timeout or API not reachable. Continuing to next step.");
  }
}

function isOctokitError(err: unknown): err is RequestError {
  return !!err && typeof err === "object" && "status" in err;
}

async function fetchGithub(token: string, runId: number) {
  const octokit = getOctokit(token);

  core.info(`Get workflow run for ${runId}`);
  const workflowRun = await getWorkflowRun(context, octokit, runId);

  core.info("Get jobs");
  const jobs = await listJobsForWorkflowRun(context, octokit, runId);

  core.info("Get job annotations");
  const jobsId = (jobs ?? []).map((job) => job.id);
  let jobAnnotations = {};
  try {
    jobAnnotations = await getJobsAnnotations(context, octokit, jobsId);
  } catch (error) {
    if (isOctokitError(error)) {
      core.info(`Failed to get job annotations: ${error.message}}`);
    } else {
      throw error;
    }
  }

  core.info("Get PRs labels");
  const prNumbers = (workflowRun.pull_requests ?? []).map((pr) => pr.number);
  let prLabels = {};
  try {
    prLabels = await getPRsLabels(context, octokit, prNumbers);
  } catch (error) {
    if (isOctokitError(error)) {
      core.info(`Failed to get PRs labels: ${error.message}}`);
    } else {
      throw error;
    }
  }

  return { workflowRun, jobs, jobAnnotations, prLabels };
}

async function run() {
  try {
    await validateSubscription();

    const otlpEndpoint = core.getInput("otlpEndpoint");
    const otlpHeaders = core.getInput("otlpHeaders");
    const otelServiceName = core.getInput("otelServiceName") || process.env["OTEL_SERVICE_NAME"] || "";
    const runId = Number.parseInt(core.getInput("runId") || `${context.runId}`, 10);
    const extraAttributes = stringToRecord(core.getInput("extraAttributes"));
    const ghToken = core.getInput("githubToken") || process.env["GITHUB_TOKEN"] || "";

    core.info("Use Github API to fetch workflow data");
    const { workflowRun, jobs, jobAnnotations, prLabels } = await fetchGithub(ghToken, runId);

    core.info(`Create tracer provider for ${otlpEndpoint}`);
    const attributes: Attributes = {
      [ATTR_SERVICE_NAME]: otelServiceName || workflowRun.name || `${workflowRun.workflow_id}`,
      [ATTR_SERVICE_INSTANCE_ID]: [
        workflowRun.repository.full_name,
        `${workflowRun.workflow_id}`,
        `${workflowRun.id}`,
        `${workflowRun.run_attempt ?? 1}`,
      ].join("/"),
      [ATTR_SERVICE_NAMESPACE]: workflowRun.repository.full_name,
      [ATTR_SERVICE_VERSION]: workflowRun.head_sha,
      ...extraAttributes,
    };
    const provider = createTracerProvider(otlpEndpoint, otlpHeaders, attributes);

    core.info(`Trace workflow run for ${runId} and export to ${otlpEndpoint}`);
    const traceId = traceWorkflowRun(workflowRun, jobs, jobAnnotations, prLabels);

    core.setOutput("traceId", traceId);
    core.info(`traceId: ${traceId}`);

    core.info("Flush and shutdown tracer provider");
    await provider.forceFlush();
    await provider.shutdown();
    core.info("Provider shutdown");
  } catch (error) {
    const message = error instanceof Error ? error : JSON.stringify(error);
    core.setFailed(message);
  }
}

export { isOctokitError, run };
