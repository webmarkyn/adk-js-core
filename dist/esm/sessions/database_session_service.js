/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from "pg";
import { randomUUID } from "../utils/env_aware_utils.js";
import {
  BaseSessionService
} from "./base_session_service.js";
import { createSession } from "./session.js";
import { State } from "./state.js";
const CREATE_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app_states (
    app_name TEXT PRIMARY KEY,
    state JSONB NOT NULL DEFAULT '{}'::jsonb,
    update_time DOUBLE PRECISION NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS user_states (
    app_name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    state JSONB NOT NULL DEFAULT '{}'::jsonb,
    update_time DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (app_name, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    app_name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    state JSONB NOT NULL DEFAULT '{}'::jsonb,
    create_time DOUBLE PRECISION NOT NULL,
    update_time DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (app_name, user_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT NOT NULL,
    app_name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    timestamp DOUBLE PRECISION NOT NULL,
    event_data JSONB NOT NULL,
    PRIMARY KEY (app_name, user_id, session_id, id),
    FOREIGN KEY (app_name, user_id, session_id)
      REFERENCES sessions(app_name, user_id, id) ON DELETE CASCADE
  )`
];
class DatabaseSessionService extends BaseSessionService {
  constructor(dbUrl, poolOptions = {}) {
    super();
    this.pool = new Pool({
      connectionString: dbUrl,
      ...poolOptions
    });
  }
  async createSession({ appName, userId, state, sessionId }) {
    await this.ensureSchema();
    const cleanedSessionId = sessionId == null ? void 0 : sessionId.trim();
    const resolvedSessionId = cleanedSessionId || randomUUID();
    const now = Date.now();
    const stateDelta = this.extractStateDelta(state);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (cleanedSessionId) {
        const exists = await client.query(
          "SELECT 1 FROM sessions WHERE app_name=$1 AND user_id=$2 AND id=$3",
          [appName, userId, cleanedSessionId]
        );
        if (exists.rowCount) {
          throw new Error(`Session with id ${cleanedSessionId} already exists.`);
        }
      }
      await this.upsertAppState(
        client,
        appName,
        stateDelta.app,
        now
      );
      await this.upsertUserState(
        client,
        appName,
        userId,
        stateDelta.user,
        now
      );
      await client.query(
        "INSERT INTO sessions (app_name, user_id, id, state, create_time, update_time) VALUES ($1, $2, $3, $4, $5, $5)",
        [
          appName,
          userId,
          resolvedSessionId,
          JSON.stringify(stateDelta.session),
          now
        ]
      );
      const appState = await this.getAppState(client, appName);
      const userState = await this.getUserState(client, appName, userId);
      await client.query("COMMIT");
      const mergedState = this.mergeState(appState, userState, stateDelta.session);
      return createSession({
        id: resolvedSessionId,
        appName,
        userId,
        state: mergedState,
        events: [],
        lastUpdateTime: now
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async getSession({ appName, userId, sessionId, config }) {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      const sessionResult = await client.query(
        "SELECT state, update_time FROM sessions WHERE app_name=$1 AND user_id=$2 AND id=$3",
        [appName, userId, sessionId]
      );
      if (!sessionResult.rowCount) {
        return void 0;
      }
      const sessionState = this.parseJsonRecord(sessionResult.rows[0].state);
      const lastUpdateTime = Number(sessionResult.rows[0].update_time);
      const { query, params } = this.buildEventQuery(
        appName,
        userId,
        sessionId,
        config
      );
      const eventsResult = await client.query(query, params);
      const events = eventsResult.rows.map((row) => this.toEvent(row)).reverse();
      const appState = await this.getAppState(client, appName);
      const userState = await this.getUserState(client, appName, userId);
      const mergedState = this.mergeState(appState, userState, sessionState);
      return createSession({
        id: sessionId,
        appName,
        userId,
        state: mergedState,
        events,
        lastUpdateTime
      });
    } finally {
      client.release();
    }
  }
  async listSessions({ appName, userId }) {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      const sessionResult = await client.query(
        "SELECT id, update_time FROM sessions WHERE app_name=$1 AND user_id=$2",
        [appName, userId]
      );
      const sessions = sessionResult.rows.map((row) => createSession({
        id: row.id,
        appName,
        userId,
        state: {},
        events: [],
        lastUpdateTime: Number(row.update_time)
      }));
      return { sessions };
    } finally {
      client.release();
    }
  }
  async deleteSession({ appName, userId, sessionId }) {
    await this.ensureSchema();
    await this.pool.query(
      "DELETE FROM sessions WHERE app_name=$1 AND user_id=$2 AND id=$3",
      [appName, userId, sessionId]
    );
  }
  async appendEvent({ session, event }) {
    await this.ensureSchema();
    if (event.partial) {
      return event;
    }
    const trimmedEvent = this.trimTempStateDelta(event);
    const eventTimestamp = trimmedEvent.timestamp;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sessionResult = await client.query(
        "SELECT update_time FROM sessions WHERE app_name=$1 AND user_id=$2 AND id=$3",
        [session.appName, session.userId, session.id]
      );
      if (!sessionResult.rowCount) {
        throw new Error(`Session ${session.id} not found.`);
      }
      const storedUpdateTime = Number(sessionResult.rows[0].update_time);
      if (storedUpdateTime > session.lastUpdateTime) {
        throw new Error(
          "The lastUpdateTime provided in the session object is earlier than the update_time in storage. Please check if it is a stale session."
        );
      }
      let hasSessionStateDelta = false;
      if (trimmedEvent.actions && trimmedEvent.actions.stateDelta) {
        const stateDelta = this.extractStateDelta(
          trimmedEvent.actions.stateDelta
        );
        if (Object.keys(stateDelta.app).length) {
          await this.upsertAppState(
            client,
            session.appName,
            stateDelta.app,
            eventTimestamp
          );
        }
        if (Object.keys(stateDelta.user).length) {
          await this.upsertUserState(
            client,
            session.appName,
            session.userId,
            stateDelta.user,
            eventTimestamp
          );
        }
        if (Object.keys(stateDelta.session).length) {
          await this.updateSessionStateInDb(
            client,
            session.appName,
            session.userId,
            session.id,
            stateDelta.session,
            eventTimestamp
          );
          hasSessionStateDelta = true;
        }
      }
      await client.query(
        "INSERT INTO events (id, app_name, user_id, session_id, invocation_id, timestamp, event_data) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [
          trimmedEvent.id,
          session.appName,
          session.userId,
          session.id,
          trimmedEvent.invocationId,
          trimmedEvent.timestamp,
          JSON.stringify(trimmedEvent)
        ]
      );
      if (!hasSessionStateDelta) {
        await client.query(
          "UPDATE sessions SET update_time=$1 WHERE app_name=$2 AND user_id=$3 AND id=$4",
          [eventTimestamp, session.appName, session.userId, session.id]
        );
      }
      await client.query("COMMIT");
      session.lastUpdateTime = eventTimestamp;
      await super.appendEvent({ session, event: trimmedEvent });
      return trimmedEvent;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
  async ensureSchema() {
    if (!this.schemaReady) {
      this.schemaReady = this.createSchema();
    }
    return this.schemaReady;
  }
  async createSchema() {
    const client = await this.pool.connect();
    try {
      for (const statement of CREATE_SCHEMA_SQL) {
        await client.query(statement);
      }
    } finally {
      client.release();
    }
  }
  async upsertAppState(client, appName, delta, now) {
    await client.query(
      "INSERT INTO app_states (app_name, state, update_time) VALUES ($1, $2, $3) ON CONFLICT (app_name) DO UPDATE SET state = app_states.state || EXCLUDED.state, update_time = EXCLUDED.update_time",
      [appName, JSON.stringify(delta), now]
    );
  }
  async upsertUserState(client, appName, userId, delta, now) {
    await client.query(
      "INSERT INTO user_states (app_name, user_id, state, update_time) VALUES ($1, $2, $3, $4) ON CONFLICT (app_name, user_id) DO UPDATE SET state = user_states.state || EXCLUDED.state, update_time = EXCLUDED.update_time",
      [appName, userId, JSON.stringify(delta), now]
    );
  }
  async updateSessionStateInDb(client, appName, userId, sessionId, delta, now) {
    await client.query(
      "UPDATE sessions SET state = state || $1::jsonb, update_time=$2 WHERE app_name=$3 AND user_id=$4 AND id=$5",
      [JSON.stringify(delta), now, appName, userId, sessionId]
    );
  }
  async getAppState(client, appName) {
    const result = await client.query(
      "SELECT state FROM app_states WHERE app_name=$1",
      [appName]
    );
    if (!result.rowCount) {
      return {};
    }
    return this.parseJsonRecord(result.rows[0].state);
  }
  async getUserState(client, appName, userId) {
    const result = await client.query(
      "SELECT state FROM user_states WHERE app_name=$1 AND user_id=$2",
      [appName, userId]
    );
    if (!result.rowCount) {
      return {};
    }
    return this.parseJsonRecord(result.rows[0].state);
  }
  parseJsonRecord(value) {
    if (!value) {
      return {};
    }
    if (typeof value === "string") {
      return JSON.parse(value);
    }
    return value;
  }
  extractStateDelta(state) {
    const deltas = { app: {}, user: {}, session: {} };
    if (!state) {
      return deltas;
    }
    for (const [key, value] of Object.entries(state)) {
      if (key.startsWith(State.APP_PREFIX)) {
        deltas.app[key.replace(State.APP_PREFIX, "")] = value;
      } else if (key.startsWith(State.USER_PREFIX)) {
        deltas.user[key.replace(State.USER_PREFIX, "")] = value;
      } else if (!key.startsWith(State.TEMP_PREFIX)) {
        deltas.session[key] = value;
      }
    }
    return deltas;
  }
  mergeState(appState, userState, sessionState) {
    const mergedState = { ...sessionState };
    for (const [key, value] of Object.entries(appState)) {
      mergedState[State.APP_PREFIX + key] = value;
    }
    for (const [key, value] of Object.entries(userState)) {
      mergedState[State.USER_PREFIX + key] = value;
    }
    return mergedState;
  }
  buildEventQuery(appName, userId, sessionId, config) {
    const params = [appName, userId, sessionId];
    let query = "SELECT id, invocation_id, timestamp, event_data FROM events WHERE app_name=$1 AND user_id=$2 AND session_id=$3";
    if (config == null ? void 0 : config.afterTimestamp) {
      params.push(config.afterTimestamp);
      query += ` AND timestamp >= $${params.length}`;
    }
    query += " ORDER BY timestamp DESC";
    if (config == null ? void 0 : config.numRecentEvents) {
      params.push(config.numRecentEvents);
      query += ` LIMIT $${params.length}`;
    }
    return { query, params };
  }
  toEvent(row) {
    const eventData = this.parseJsonRecord(row.event_data);
    return {
      ...eventData,
      id: row.id,
      invocationId: row.invocation_id,
      timestamp: Number(row.timestamp)
    };
  }
  trimTempStateDelta(event) {
    if (!event.actions || !event.actions.stateDelta) {
      return event;
    }
    const filteredEntries = Object.entries(event.actions.stateDelta).filter(([key]) => !key.startsWith(State.TEMP_PREFIX));
    if (filteredEntries.length === Object.keys(event.actions.stateDelta).length) {
      return event;
    }
    return {
      ...event,
      actions: {
        ...event.actions,
        stateDelta: Object.fromEntries(filteredEntries)
      }
    };
  }
}
export {
  DatabaseSessionService
};
