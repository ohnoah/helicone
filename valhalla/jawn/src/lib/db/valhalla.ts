import { Pool, QueryResult, PoolClient } from "pg";
import { getEnvironment } from "../environment/get";
import { PromiseGenericResult, err, ok } from "../../packages/common/result";
import {
  ValhallaFeedback,
  ValhallaRequest,
  ValhallaResponse,
} from "./valhalla.database.types";

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

export interface IValhallaDB {
  query(query: string, values: any[]): PromiseGenericResult<QueryResult<any>>;
  now(): PromiseGenericResult<QueryResult<any>>;
  insertRequest(
    request: ValhallaRequest
  ): PromiseGenericResult<QueryResult<any>>;
  insertResponse(
    response: ValhallaResponse
  ): PromiseGenericResult<QueryResult<any>>;
  updateResponse(
    response: ValhallaResponse
  ): PromiseGenericResult<QueryResult<any>>;
  upsertFeedback(
    feedback: ValhallaFeedback
  ): PromiseGenericResult<QueryResult<any>>;
  close(): Promise<void>;
}

class ValhallaDB implements IValhallaDB {
  pool: Pool;
  constructor(auroraCreds: string) {
    const auroraHost = process.env.AURORA_HOST;
    const auroraPort = process.env.AURORA_PORT;
    const auroraDb = process.env.AURORA_DATABASE;

    if (!auroraCreds) {
      throw new Error("No creds");
    }

    if (!auroraHost) {
      throw new Error("No host");
    }

    if (!auroraPort) {
      throw new Error("No port");
    }

    if (!auroraDb) {
      throw new Error("No database");
    }

    const {
      username,
      password,
    }: {
      username: string;
      password: string;
    } = JSON.parse(auroraCreds);

    this.pool = new Pool({
      host: auroraHost,
      port: parseInt(auroraPort),
      user: username,
      password: password,
      database: auroraDb,
      max: 2_000,
      idleTimeoutMillis: 1000, // close idle clients after 1 second
      connectionTimeoutMillis: 1000, // return an error after 1 second if connection could not be established
      maxUses: 500,
      ssl:
        getEnvironment() === "development"
          ? undefined
          : {
              rejectUnauthorized: true, // This should be set to true for better security
            },
    });

    this.pool.on("error", (err, client) => {
      try {
        console.error(
          "Error occurred on client",
          client,
          "err",
          JSON.stringify(err)
        );
        client.release();
      } catch (e) {
        console.error("Error occurred on client", client, "err", err);
      }
    });
  }

  async close() {
    await this.pool.end();
  }

  async query(
    query: string,
    values: any[] = []
  ): PromiseGenericResult<QueryResult<any>> {
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
    } catch (thrownErr) {
      console.error("Error in query", query, thrownErr);
      return err(JSON.stringify(thrownErr));
    }

    try {
      const result = await client.query(query, values);
      client.release();
      return ok(result);
    } catch (thrownErr) {
      console.error("Error in query", query, thrownErr);
      client.release();
      return err(JSON.stringify(thrownErr));
    }
  }

  async now() {
    return this.query("SELECT NOW() as now");
  }

  async upsertFeedback(
    feedback: ValhallaFeedback
  ): PromiseGenericResult<QueryResult<any>> {
    const query = `
      INSERT INTO feedback (
        response_id,
        rating,
        created_at
      )
      VALUES (
        $1, $2, $3
      )
      ON CONFLICT (response_id) DO UPDATE SET
        rating = EXCLUDED.rating,
        created_at = EXCLUDED.created_at;
    `;
    return this.query(query, [
      feedback.responseID,
      feedback.rating,
      feedback.createdAt.toISOString(),
    ]);
  }

  async updateResponse(
    response: ValhallaResponse
  ): PromiseGenericResult<QueryResult<any>> {
    const query = `
      UPDATE response
      SET
        body = $1,
        delay_ms = $2,
        http_status = $3,
        completion_tokens = $4,
        model = $5,
        prompt_tokens = $6,
        response_received_at = $7,
        prompt_cache_write_tokens = $8,
        prompt_cache_read_tokens = $9
      WHERE id = $10
    `;
    return this.query(query, [
      JSON.stringify(response.body),
      response.delayMs,
      response.http_status,
      response.completionTokens,
      response.model,
      response.promptTokens,
      response.responseReceivedAt?.toISOString(),
      response.promptCacheWriteTokens,
      response.promptCacheReadTokens,
      response.id,
    ]);
  }

  async insertRequest(
    request: ValhallaRequest
  ): PromiseGenericResult<QueryResult<any>> {
    const query = `
      INSERT INTO request (
        id,
        created_at,
        url_href,
        user_id,
        properties,
        helicone_org_id,
        provider,
        body,
        request_received_at,
        model
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
      );
    `;
    console.log("Inserting request", request.id);
    return this.query(query, [
      request.id,
      request.createdAt.toISOString(),
      request.urlHref,
      request.userId,
      JSON.stringify(request.properties),
      request.heliconeOrgID,
      request.provider,
      JSON.stringify(request.body),
      request.requestReceivedAt.toISOString(),
      request.model,
    ]);
  }

  async insertResponse(
    response: ValhallaResponse
  ): PromiseGenericResult<QueryResult<any>> {
    const query = `
    INSERT INTO response (
      id,
      created_at,
      body,
      request,
      delay_ms,
      http_status,
      completion_tokens,
      model,
      prompt_tokens,
      response_received_at,
      helicone_org_id,
      prompt_cache_write_tokens,
      prompt_cache_read_tokens
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
  `;
    return this.query(query, [
      response.id,
      response.createdAt.toISOString(),
      JSON.stringify(response.body),
      response.request,
      response.delayMs,
      response.http_status,
      response.completionTokens,
      response.model,
      response.promptTokens,
      response.responseReceivedAt?.toISOString(),
      response.heliconeOrgID,
      response.promptCacheWriteTokens,
      response.promptCacheReadTokens,
    ]);
  }
}

class StaticValhallaPool {
  private static client: ValhallaDB | null = null;

  static getClient(): IValhallaDB {
    if (this.client === null) {
      const auroraCreds = process.env.AURORA_CREDS;
      if (!auroraCreds) {
        // TODO get from secrets manager?
        throw new Error("No creds found in secret");
      } else {
        this.client = new ValhallaDB(auroraCreds);
      }
    }
    return this.client;
  }
}

export function createValhallaClient(): IValhallaDB {
  return StaticValhallaPool.getClient();
}
