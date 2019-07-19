import { Status } from "../grpc";
import * as api from "../../api";
import * as logger from "../../logger";

const API_VERSION = "v1";

interface Target {
  name: string;
}

interface OperationResponse {
  [Name: string]: string;
}

type OperationResult = OperationResponse | Status;

interface OperationBase {
  name: string;
  metadata: { [Name: string]: string };
  done: boolean;
}

type Operation = OperationBase & OperationResult;

async function getOperation(target: Target): Promise<Operation> {
  try {
    const { body } = await api.request("GET", "/" + API_VERSION + "/" + target.name, {
      auth: true,
      origin: api.functionsOrigin,
    });

    return body;
  } catch (error) {
    logger.debug("[functions] failed to get status of operation: " + target.name);
    logger.debug("[functions] " + error.message);

    throw error;
  }
}

export const operations = {
  get: getOperation,
};
