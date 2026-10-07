import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { getEnv } from "@/lib/env";
import { GatewayError } from "@/lib/errors";
import { policySchema, type Policy } from "./schema";

export interface LoadedPolicy {
  policy: Policy;
  /** The YAML exactly as written on disk, shown in the dashboard policy viewer. */
  raw: string;
  file: string;
}

function policyDir(dir?: string): string {
  return path.resolve(dir ?? getEnv().LEDGERLINE_POLICY_DIR);
}

function parsePolicyFile(file: string): LoadedPolicy {
  const raw = fs.readFileSync(file, "utf8");
  const name = path.basename(file);

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new GatewayError(500, "policy_invalid", `Policy file ${name} is not valid YAML: ${(err as Error).message}`);
  }

  const parsed = policySchema.safeParse(data);
  if (!parsed.success) {
    throw new GatewayError(
      500,
      "policy_invalid",
      `Policy file ${name} failed validation`,
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  // The file name is how a policy is looked up, so it must agree with the content.
  if (`${parsed.data.app_id}.yaml` !== name) {
    throw new GatewayError(500, "policy_invalid", `Policy file ${name} declares app_id "${parsed.data.app_id}"; the two must match`);
  }
  return { policy: parsed.data, raw, file: name };
}

/**
 * Policies are read from disk on every request. The files are tiny, and it
 * means an edited policy takes effect immediately with no restart or cache.
 */
export function loadPolicy(appId: string, dir?: string): LoadedPolicy {
  // appId is validated as a slug before it gets here, so it cannot escape the folder.
  const file = path.join(policyDir(dir), `${appId}.yaml`);
  if (!fs.existsSync(file)) {
    throw new GatewayError(404, "unknown_app", `No policy is defined for app "${appId}"`);
  }
  return parsePolicyFile(file);
}

export function loadAllPolicies(dir?: string): LoadedPolicy[] {
  const folder = policyDir(dir);
  if (!fs.existsSync(folder)) {
    throw new GatewayError(500, "policy_dir_missing", `Policy folder not found: ${folder}`);
  }
  return fs
    .readdirSync(folder)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => parsePolicyFile(path.join(folder, f)));
}
