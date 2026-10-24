/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentConnections from "../agentConnections.js";
import type * as auth from "../auth.js";
import type * as context from "../context.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as lib_agent from "../lib/agent.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_names from "../lib/names.js";
import type * as lib_ops from "../lib/ops.js";
import type * as lib_validators from "../lib/validators.js";
import type * as mcp from "../mcp.js";
import type * as seed from "../seed.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentConnections: typeof agentConnections;
  auth: typeof auth;
  context: typeof context;
  files: typeof files;
  http: typeof http;
  "lib/agent": typeof lib_agent;
  "lib/auth": typeof lib_auth;
  "lib/names": typeof lib_names;
  "lib/ops": typeof lib_ops;
  "lib/validators": typeof lib_validators;
  mcp: typeof mcp;
  seed: typeof seed;
  workspaces: typeof workspaces;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
