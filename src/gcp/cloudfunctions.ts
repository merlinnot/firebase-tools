import * as _ from "lodash";
import * as clc from "cli-color";

import * as api from "../api";
import { FirebaseError } from "../error";
import * as logger from "../logger";
import * as utils from "../utils";

const API_VERSION = "v1";
const ERR_DEPLOYMENT_QUOTA_EXCEEDED_MESSAGE =
  "You have exceeded your deployment quota, please deploy your functions in " +
  "batches by using the --only flag, and wait a few minutes before deploying " +
  "again. Go to https://firebase.google.com/docs/cli/#partial_deploys to " +
  "learn more.";
const ERR_GENERATE_UPLOAD_URL_FAILURE_MESSAGE =
  "\n\nThere was an issue deploying your functions. Verify that your project " +
  "has a Google App Engine instance setup at " +
  "https://console.cloud.google.com/appengine and try again. If this issue " +
  "persists, please contact support.";

export const DEFAULT_REGION = "us-central1";

interface Target {
  functionName: string;
  locationName: string;
  projectId: string;
}

enum OperationType {
  Create = "create",
  Delete = "delete",
  Update = "update",
}

type CloudFunctionStatus =
  | "CLOUD_FUNCTION_STATUS_UNSPECIFIED"
  | "ACTIVE"
  | "OFFLINE"
  | "DEPLOY_IN_PROGRESS"
  | "DELETE_IN_PROGRESS"
  | "UNKNOWN";

interface SourceRepository {
  url: string;
  deployedUrl: string;
}

type CloudFunctionSourceCode =
  | { sourceArchiveUrl: string }
  | { sourceRepository: SourceRepository }
  | { sourceUploadUrl: string };

interface HttpsTrigger {
  url: string;
}

interface FailurePolicy {
  retry: {};
}

interface EventTrigger {
  eventType: string;
  resource: string;
  service: string;
  failurePolicy: FailurePolicy;
}

type Trigger = HttpsTrigger & EventTrigger;

interface CloudFunctionBase {
  name: string;
  description: string;
  status: CloudFunctionStatus;
  entryPoint: string;
  runtime: string;
  timeout: string;
  availableMemoryMb: number;
  serviceAccountEmail: string;
  updateTime: string;
  versionId: string;
  labels: { [Name: string]: string };
  environmentVariables: { [Name: string]: string };
  network: string;
  maxInstances: number;
  vpcConnector: string;
}

/**
 * Describes a Cloud Function that contains user computation executed in
 * response to an event. It encapsulate function and triggers configurations.
 *
 * @see https://cloud.google.com/functions/docs/reference/rest/v1/projects.locations.functions#resource-cloudfunction
 */
type CloudFunction = CloudFunctionBase & CloudFunctionSourceCode & Trigger;

function makePath({
  projectId,
  locationName,
  functionName,
}: Omit<Target, "functionName"> & Partial<Pick<Target, "functionName">>): string {
  const projectPath = `/${API_VERSION}/projects/${projectId}`;
  const locationPath = `${projectPath}/locations/${locationName}`;
  const functionsPath = `${locationPath}/functions`;

  return typeof functionName === "string" ? `${functionsPath}/${functionName}` : functionsPath;
}

async function makeFirebaseError(
  functionName: string,
  operationType: OperationType,
  error: FirebaseError
): Promise<FirebaseError> {
  utils.logWarning(
    clc.bold.yellow("functions:") + " failed to " + operationType + " function " + functionName
  );

  if (_.get(error, ["context", "response", "statusCode"]) === 429) {
    logger.debug(error.message);
    logger.info(ERR_DEPLOYMENT_QUOTA_EXCEEDED_MESSAGE);
  } else {
    logger.info(error.message);
  }

  throw new FirebaseError(`Failed to ${operationType} function ${functionName}`, {
    original: error,
    context: { function: functionName },
  });
}

/**
 * Returns a signed URL for uploading a function source code.
 *
 * @see https://cloud.google.com/functions/docs/reference/rest/v1/projects.locations.functions/generateUploadUrl
 */
async function generateUploadUrl(projectId: string, locationName: string): Promise<string> {
  const functionsPath = makePath({ projectId, locationName });
  const generateUploadUrlPath = `${functionsPath}:generateUploadUrl`;

  try {
    const {
      body: { uploadUrl },
    } = await api.request("POST", generateUploadUrlPath, {
      auth: true,
      json: false,
      origin: api.functionsOrigin,
      retryCodes: [503],
    });

    return uploadUrl;
  } catch (error) {
    logger.info(ERR_GENERATE_UPLOAD_URL_FAILURE_MESSAGE);

    throw error;
  }
}

async function createFunction(
  { projectId, locationName, functionName }: Target,
  cloudFunction: Exclude<CloudFunction, "status" | "updateTime" | "versionId">
): Promise<CloudFunction> {
  const functionsPath = makePath({ projectId, locationName, functionName });

  try {
    const { body } = await api.request("POST", functionsPath, {
      auth: true,
      data: cloudFunction,
      origin: api.functionsOrigin,
    });

    return body;
  } catch (error) {
    throw makeFirebaseError(cloudFunction.name, OperationType.Create, error);
  }
}

async function patchFunction(
  { projectId, locationName, functionName }: Target,
  cloudFunction: Exclude<CloudFunction, "status" | "updateTime" | "versionId">
): Promise<CloudFunction> {
  const functionsPath = makePath({ projectId, locationName, functionName });

  const data = _.assign(
    {
      sourceUploadUrl: options.sourceUploadUrl,
      name: func,
      labels: options.labels,
    },
    options.trigger
  );
  let masks = ["sourceUploadUrl", "name", "labels"];

  if (options.runtime) {
    data.runtime = options.runtime;
    masks = _.concat(masks, "runtime");
  }
  if (options.availableMemoryMb) {
    data.availableMemoryMb = options.availableMemoryMb;
    masks.push("availableMemoryMb");
  }
  if (options.timeout) {
    data.timeout = options.timeout;
    masks.push("timeout");
  }
  if (options.trigger.eventTrigger) {
    masks = _.concat(
      masks,
      _.map(_.keys(options.trigger.eventTrigger), function(subkey: string) {
        return "eventTrigger." + subkey;
      })
    );
  } else {
    masks = _.concat(masks, "httpsTrigger");
  }

  return api
    .request("PATCH", endpoint, {
      qs: {
        updateMask: masks.join(","),
      },
      auth: true,
      data,
      origin: api.functionsOrigin,
    })
    .then(
      function(resp) {
        return Promise.resolve({
          func,
          done: false,
          name: resp.body.name,
          type: "update",
        });
      },
      function(err) {
        return logAndRejectOperation(options.functionName, "update", err);
      }
    );
}

async function deleteFunction(options: any) {
  const location = "projects/" + options.projectId + "/locations/" + options.region;
  const func = location + "/functions/" + options.functionName;
  const endpoint = "/" + API_VERSION + "/" + func;
  return api
    .request("DELETE", endpoint, {
      auth: true,
      origin: api.functionsOrigin,
    })
    .then(
      function(resp) {
        return Promise.resolve({
          func,
          done: false,
          name: resp.body.name,
          type: "delete",
        });
      },
      function(err) {
        return logAndRejectOperation(options.functionName, "delete", err);
      }
    );
}

async function listFunctions(projectId: string, region: string) {
  const endpoint =
    "/" + API_VERSION + "/projects/" + projectId + "/locations/" + region + "/functions";
  return api
    .request("GET", endpoint, {
      auth: true,
      origin: api.functionsOrigin,
    })
    .then(
      function(resp) {
        const functionsList = resp.body.functions || [];
        _.forEach(functionsList, function(f) {
          f.functionName = f.name.substring(f.name.lastIndexOf("/") + 1);
        });
        return Promise.resolve(functionsList);
      },
      function(err) {
        logger.debug("[functions] failed to list functions for " + projectId);
        logger.debug("[functions] " + err.message);
        return Promise.reject(err.message);
      }
    );
}

export const functions = {
  create: createFunction,
  delete: deleteFunction,
  generateUploadUrl,
  list: listFunctions,
  patch: patchFunction,
};
