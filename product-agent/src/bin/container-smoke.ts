import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const DEFAULT_IMAGE = "direxio/product-agent:memory-skill-smoke";
const AGENT_DATA_DIR = "/var/lib/direxio-product-agent";

interface DockerSmokeNames {
  id: string;
  network: string;
  volume: string;
  gateway: string;
  agent: string;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});

/**
 * Function: Runs a Docker image-level smoke for product-agent memory and Prompt Skills.
 * Inputs:
 * - DIREXIO_PRODUCT_AGENT_SMOKE_IMAGE: Optional local image tag to build/run.
 * - DIREXIO_PRODUCT_AGENT_SMOKE_SKIP_BUILD=1: Reuse an existing image instead of building.
 * Output:
 * - Logs a success line when the image survives write, restart, and verify phases.
 * Side effects:
 * - Builds a local Docker image, starts temporary containers/network/volume, then removes them.
 * Errors:
 * - Throws when Docker is unavailable or any smoke phase fails.
 */
async function main(): Promise<void> {
  const image = process.env.DIREXIO_PRODUCT_AGENT_SMOKE_IMAGE || DEFAULT_IMAGE;
  const skipBuild = process.env.DIREXIO_PRODUCT_AGENT_SMOKE_SKIP_BUILD === "1";
  const names = namesForSmoke();

  await runDocker(["info", "--format", "{{.ServerVersion}}"], { label: "check docker daemon", quiet: true });
  if (!skipBuild) {
    await runDocker(["build", "-t", image, "."], { label: "build product-agent image" });
  }
  await runDocker([
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    image,
    "-lc",
    "test -f dist/bin/remote-smoke-runner.js && test -f dist/bin/agent-service.js"
  ], { label: "verify compiled smoke runner exists", quiet: true });

  try {
    await runDocker(["network", "create", names.network], { label: "create smoke network", quiet: true });
    await runDocker(["volume", "create", names.volume], { label: "create smoke volume", quiet: true });
    await runDocker([
      "run",
      "-d",
      "--name",
      names.gateway,
      "--network",
      names.network,
      "node:22-alpine",
      "node",
      "-e",
      fakeGatewayScript()
    ], { label: "start fake gateway", quiet: true });
    await runDocker([
      "run",
      "-d",
      "--name",
      names.agent,
      "--network",
      names.network,
      "-e",
      `DIREXIO_AGENT_DATA_DIR=${AGENT_DATA_DIR}`,
      "-e",
      "DIREXIO_AI_TOKEN=dxai_smoke",
      "-e",
      `DIREXIO_AI_GATEWAY_URL=http://${names.gateway}:8787`,
      "--mount",
      `source=${names.volume},target=${AGENT_DATA_DIR}`,
      image
    ], { label: "start product-agent", quiet: true });

    await runRemoteSmokePhase(names.agent, names.id, "write");
    await runDocker(["restart", names.agent], { label: "restart product-agent", quiet: true });
    await runRemoteSmokePhase(names.agent, names.id, "verify");
    console.log("container product-agent memory+prompt-skill smoke ok");
  } finally {
    await cleanup(names);
  }
}

/**
 * Function: Runs one compiled remote smoke runner phase inside the product-agent container.
 * Inputs:
 * - agentContainer: Docker container name for product-agent.
 * - smokeId: Stable id shared by write and verify phases.
 * - phase: `write` or `verify`.
 * Output:
 * - The runner logs phase-specific success.
 * Side effects:
 * - Executes Node inside the running product-agent container.
 * Errors:
 * - Propagates docker exec failures.
 */
async function runRemoteSmokePhase(
  agentContainer: string,
  smokeId: string,
  phase: "write" | "verify"
): Promise<void> {
  await runDocker([
    "exec",
    "-e",
    `PRODUCT_AGENT_SMOKE_ID=${smokeId}`,
    "-e",
    `PRODUCT_AGENT_SMOKE_PHASE=${phase}`,
    agentContainer,
    "node",
    "dist/bin/remote-smoke-runner.js"
  ], { label: `remote smoke ${phase}` });
}

/**
 * Function: Removes temporary Docker resources created by the smoke.
 * Inputs:
 * - names: Unique resource names created for this run.
 * Output:
 * - Best-effort cleanup; failures are ignored.
 * Side effects:
 * - Removes temporary containers, volume, and network.
 * Errors:
 * - None; cleanup intentionally ignores missing resources.
 */
async function cleanup(names: DockerSmokeNames): Promise<void> {
  await runDocker(["rm", "-f", names.agent], { label: "cleanup product-agent", ignoreFailure: true, quiet: true });
  await runDocker(["rm", "-f", names.gateway], { label: "cleanup fake gateway", ignoreFailure: true, quiet: true });
  await runDocker(["volume", "rm", names.volume], { label: "cleanup smoke volume", ignoreFailure: true, quiet: true });
  await runDocker(["network", "rm", names.network], { label: "cleanup smoke network", ignoreFailure: true, quiet: true });
}

function namesForSmoke(): DockerSmokeNames {
  const id = `container-smoke-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  return {
    id,
    network: `direxio-agent-${id}`,
    volume: `direxio-agent-${id}`,
    gateway: `direxio-gateway-${id}`,
    agent: `direxio-product-agent-${id}`
  };
}

function fakeGatewayScript(): string {
  return [
    "const http=require('http');",
    "http.createServer((req,res)=>{",
    "let body='';",
    "req.on('data',chunk=>body+=chunk);",
    "req.on('end',()=>{",
    "res.writeHead(200,{'content-type':'application/json'});",
    "res.end(JSON.stringify({reply:'container smoke reply'}));",
    "});",
    "}).listen(8787,'0.0.0.0');"
  ].join("");
}

function runDocker(
  args: string[],
  options: { label: string; ignoreFailure?: boolean; quiet?: boolean }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: process.cwd(),
      stdio: options.quiet ? "ignore" : "inherit",
      shell: false
    });
    child.on("error", (error) => {
      if (options.ignoreFailure) {
        resolve();
        return;
      }
      reject(new Error(`${options.label} failed to start: ${error.message}`));
    });
    child.on("exit", (code) => {
      if (code === 0 || options.ignoreFailure) {
        resolve();
        return;
      }
      reject(new Error(`${options.label} failed with exit code ${code}`));
    });
  });
}
