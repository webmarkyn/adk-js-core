/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { PoolConfig } from 'pg';
import { Event } from '../events/event.js';
import { AppendEventRequest, BaseSessionService, CreateSessionRequest, DeleteSessionRequest, GetSessionRequest, ListSessionsRequest, ListSessionsResponse } from './base_session_service.js';
import { Session } from './session.js';
/**
 * A session service that uses PostgreSQL for storage via pg.
 */
export declare class DatabaseSessionService extends BaseSessionService {
    private readonly pool;
    private schemaReady?;
    constructor(dbUrl: string, poolOptions?: PoolConfig);
    createSession({ appName, userId, state, sessionId }: CreateSessionRequest): Promise<Session>;
    getSession({ appName, userId, sessionId, config }: GetSessionRequest): Promise<Session | undefined>;
    listSessions({ appName, userId }: ListSessionsRequest): Promise<ListSessionsResponse>;
    deleteSession({ appName, userId, sessionId }: DeleteSessionRequest): Promise<void>;
    appendEvent({ session, event }: AppendEventRequest): Promise<Event>;
    close(): Promise<void>;
    private ensureSchema;
    private createSchema;
    private upsertAppState;
    private upsertUserState;
    private updateSessionStateInDb;
    private getAppState;
    private getUserState;
    private parseJsonRecord;
    private extractStateDelta;
    private mergeState;
    private buildEventQuery;
    private toEvent;
    private trimTempStateDelta;
}
